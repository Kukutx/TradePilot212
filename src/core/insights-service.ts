// Read-only portfolio insights built from Trading 212 history endpoints.
// Nothing in this file can place, change, or cancel an order.

import type { AccountSummary, Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type {
  AllocationAnalysis,
  Exchange,
  ExportReport,
  HistoryDividendItem,
  HistoryOrderItem,
  HistoryTransactionItem,
  IncomeSummary,
  MarketStatus,
  PerformanceSummary,
  TaxYearSummary,
  ValuePoint,
} from "../shared/history.js";
import {
  analyzeAllocation, currentTaxYear, DEFAULT_ALLOCATION_LIMITS, marketStatus, parseYearStart, summarizeIncome, summarizePerformance, summarizeTaxYear,
  taxYearWindow, validTimeZone, type AllocationLimits, type HistoryWindow,
} from "./analytics.js";
import type { RuntimeConfig } from "./config.js";
import { requireCredentials } from "./config.js";
import { scheduleStart } from "./dividends.js";
import { fail } from "./errors.js";
import { resolveInstrumentFromList } from "./trading-service.js";
import { Trading212ApiError, Trading212Client, type HistoryKind } from "./trading212-client.js";
import { accountName, ledgerPrefix, recordKey, type HistoryLedgers, type LedgerMeta } from "./history-ledger.js";

export interface InsightsDeps {
  config: RuntimeConfig;
  fetcher?: typeof fetch;
  instruments: (environment: TradingEnvironment) => Promise<Instrument[]>;
  /** Where the history read is kept between reads (history-ledger.ts); without it every read starts from the newest. */
  ledgers?: HistoryLedgers;
}

type HistoryItemOf<K extends HistoryKind> = K extends "orders" ? HistoryOrderItem : K extends "dividends" ? HistoryDividendItem : HistoryTransactionItem;
interface Collected<T> { items: T[]; truncated: boolean }

export const DEFAULT_HISTORY_PAGES = 10;
export const MAX_HISTORY_PAGES = 40;
const HISTORY_CACHE_MS = 60_000;
const EXCHANGE_CACHE_MS = 10 * 60_000;

/** Whether the ledger kept reaches back to the window's start (or is the whole history). */
async function covers(ledgers: HistoryLedgers, prefix: string, start: Date | undefined): Promise<boolean> {
  const meta = await ledgers.meta(prefix);
  if (!meta) return false;
  return meta.complete || (start !== undefined && meta.oldestAt !== undefined && Date.parse(meta.oldestAt) < start.getTime());
}

/** Records this recent may still come into the history above older ones (a movement settled late). */
const SETTLE_MS = 3 * 86_400_000;
/** History over a shorter span than this is read as it always was: a page or two, with nothing to keep. */
const LEDGER_SPAN_MS = 60 * 86_400_000;

const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * Where a record sits in the history, for how far down a read must go: the earlier of its order's creation and its
 * fill, as an order is placed by one or the other.
 */
function positionTime(kind: HistoryKind, item: HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem): number {
  if (kind !== "orders") return itemTime(kind, item);
  const { order, fill } = item as HistoryOrderItem;
  const times = [order?.createdAt, fill?.filledAt].map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : NaN;
}

/** Each record once, newest first by its time. */
function union<T extends HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem>(kind: HistoryKind, items: T[], time: (item: T) => number): T[] {
  const seen = new Set<string>();
  const once = items.filter((item) => { const key = recordKey(kind, item); if (seen.has(key)) return false; seen.add(key); return true; });
  const at = (item: T) => { const value = time(item); return Number.isFinite(value) ? value : -Infinity; };
  return once.map((item, index) => ({ item, index })).sort((a, b) => at(b.item) - at(a.item) || a.index - b.index).map(({ item }) => item);
}

/** An item's instrument, where it names one. */
function itemTicker(kind: HistoryKind, item: HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem): string | undefined {
  if (kind === "orders") { const order = (item as HistoryOrderItem).order; return order?.ticker ?? order?.instrument?.ticker; }
  if (kind === "dividends") { const dividend = item as HistoryDividendItem; return dividend.ticker ?? dividend.instrument?.ticker; }
  return undefined;
}

/**
 * The records from the window's start on, and one instrument's alone with `ticker` (cash movements name none, and
 * are all kept, as Trading 212's own filter leaves them). Records without a time are kept: the caller places them.
 */
function inWindow<T extends HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem>(kind: HistoryKind, items: T[], start: Date | undefined, ticker?: string): T[] {
  return items.filter((item) => {
    const time = itemTime(kind, item);
    if (start !== undefined && Number.isFinite(time) && time < start.getTime()) return false;
    return !ticker || kind === "transactions" || itemTicker(kind, item) === ticker;
  });
}

function itemTime(kind: HistoryKind, item: HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem): number {
  const value = kind === "orders"
    ? (item as HistoryOrderItem).fill?.filledAt ?? (item as HistoryOrderItem).order?.createdAt
    : kind === "dividends" ? (item as HistoryDividendItem).paidOn : (item as HistoryTransactionItem).dateTime;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : NaN;
}

/** One dividend or cash movement; amounts are in `currency`, the account currency for Trading 212. */
export interface CashHistoryItem {
  date: string;
  /** DIVIDEND, or Trading 212's transaction type (DEPOSIT, WITHDRAW, INTEREST, FEE …). */
  type: string;
  amount: number;
  currency: string;
  ticker?: string;
  name?: string;
  quantity?: number;
  grossPerShare?: number;
  perShareCurrency?: string;
  /** The dividend's own type, such as ORDINARY. */
  subtype?: string;
  reference?: string;
}

export type HistoryPeriod = "1w" | "1m" | "3m" | "ytd" | "1y" | "all";

/** The Trading 212 order id of a history record, as text, so a journal note can name it. */
const orderIdOf = (id: number | string | undefined): { orderId?: string } => (id === undefined || id === null || id === "" ? {} : { orderId: String(id) });

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * A date or ISO date-time; NaN when it is not one. JavaScript rolls a day past the end of the month
 * into the next (2026-02-30 becomes March 2), so the calendar date is checked first.
 */
function parseDate(value: string, endOfDay: boolean): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return NaN;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, date));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== date) return NaN;
  return DATE_ONLY.test(value) ? calendar.getTime() + (endOfDay ? DAY_MS - 1 : 0) : Date.parse(value);
}

/** A date without a time is a whole UTC day: `from` starts it and `to` ends it. */
export function parseWindow(input: { from?: string; to?: string; period?: HistoryPeriod }, now = new Date()): HistoryWindow {
  const day = DAY_MS;
  const to = input.to ? new Date(parseDate(input.to, true)) : now;
  if (Number.isNaN(to.getTime())) fail("INVALID_INPUT", "to must be a real date (YYYY-MM-DD) or an ISO date-time", { field: "to" });
  if (input.from) {
    const from = new Date(parseDate(input.from, false));
    if (Number.isNaN(from.getTime()) || from > to) fail("INVALID_INPUT", "from must be a real date (YYYY-MM-DD) or an ISO date-time before to", { field: "from" });
    return { from, to };
  }
  switch (input.period ?? "all") {
    case "1w": return { from: new Date(to.getTime() - 7 * day), to };
    case "1m": return { from: new Date(to.getTime() - 30 * day), to };
    case "3m": return { from: new Date(to.getTime() - 91 * day), to };
    case "1y": return { from: new Date(to.getTime() - 365 * day), to };
    case "ytd": return { from: new Date(Date.UTC(to.getUTCFullYear(), 0, 1)), to };
    default: return { to };
  }
}

export class InsightsService {
  private readonly historyCache = new Map<string, { expiresAt: number; value: Collected<unknown> }>();
  /** Bumped by each order or cancellation sent, so a read that was under way then is not kept. */
  private readonly historyGeneration = new Map<TradingEnvironment, number>();
  private exchangeCache = new Map<TradingEnvironment, { expiresAt: number; exchanges: Exchange[] }>();

  constructor(private readonly deps: InsightsDeps) {}

  private client(environment: TradingEnvironment) {
    requireCredentials(this.deps.config, environment);
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
  }

  /** Read the account's history afresh next time: an order or a cancellation was just sent. */
  forgetHistory(environment: TradingEnvironment): void {
    this.historyGeneration.set(environment, (this.historyGeneration.get(environment) ?? 0) + 1);
    for (const key of this.historyCache.keys()) if (key.startsWith(`${environment}:`)) this.historyCache.delete(key);
  }

  /** Walk newest-first history pages until the window start or the page budget is reached. */
  async collect<K extends HistoryKind>(environment: TradingEnvironment, kind: K, window: HistoryWindow, maxPages = DEFAULT_HISTORY_PAGES, ticker?: string): Promise<Collected<HistoryItemOf<K>>> {
    const pages = Math.max(1, Math.min(MAX_HISTORY_PAGES, Math.floor(maxPages)));
    // Rolling periods start at a different millisecond on every call; walking back to the start of that
    // UTC day lets one read serve every call made that day.
    const start = window.from ? new Date(Math.floor(window.from.getTime() / 86_400_000) * 86_400_000) : undefined;
    const key = `${environment}:${kind}:${start?.toISOString() ?? "all"}:${pages}:${ticker ?? ""}`;
    const cached = this.historyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as Collected<HistoryItemOf<K>>;

    const generation = this.historyGeneration.get(environment) ?? 0;
    const client = this.client(environment);
    const ledgers = this.deps.ledgers;
    const prefix = ledgers && ledgerPrefix(environment, await accountName(this.deps.config.trading212[environment].apiKey), kind);
    // One instrument's history is read from the ledger once it reaches back to the window's start; until then Trading
    // 212's own filter reaches further back in as many pages.
    // Short spans (today's fills, a week) are a page or two: read as they always were, without loading the ledger.
    const long = start === undefined || start.getTime() < Date.now() - LEDGER_SPAN_MS;
    if (ledgers && prefix && long && (!ticker || await covers(ledgers, prefix, start))) {
      const value = await ledgers.exclusive(prefix, () => this.fromLedger(ledgers, prefix, client, kind, start, pages, ticker));
      if (!value.limited && (this.historyGeneration.get(environment) ?? 0) === generation) this.historyCache.set(key, { expiresAt: Date.now() + HISTORY_CACHE_MS, value: value.collected });
      return value.collected;
    }
    const items: HistoryItemOf<K>[] = [];
    let next: string | undefined;
    let truncated = false;
    let limited = false;
    for (let page = 0; page < pages; page++) {
      // Past the first page, a limit that resets later than a read waits gives what was read, cut short, not nothing.
      const result = await client.getHistoryPage(kind, next, ticker).catch((error: unknown) => {
        if (page > 0 && error instanceof Trading212ApiError && error.status === 429) return undefined;
        throw error;
      });
      if (!result) { truncated = true; limited = true; break; }
      items.push(...(result.items as HistoryItemOf<K>[]));
      const oldest = result.items.length ? itemTime(kind, result.items[result.items.length - 1]!) : NaN;
      const reachedStart = start !== undefined && Number.isFinite(oldest) && oldest < start.getTime();
      if (!result.nextPagePath || reachedStart) { next = undefined; break; }
      next = result.nextPagePath;
      if (page === pages - 1) truncated = true;
    }
    const value = { items, truncated };
    // A read cut short by the limit is not kept: the next one reads it whole.
    if (!limited && (this.historyGeneration.get(environment) ?? 0) === generation) this.historyCache.set(key, { expiresAt: Date.now() + HISTORY_CACHE_MS, value });
    return value;
  }

  /**
   * The history from the ledger. First the newest pages, down past the horizon of the last read (the records that
   * could have come into the history since: an order open then that has filled, a movement settled late), adding
   * the ones not kept; then the pages further back from where the last read stopped, until the window's start, the
   * account's first record or the page budget. What is read is added to the ledger. The records in the window are
   * returned (one instrument's, with `ticker`).
   */
  private async fromLedger<K extends HistoryKind>(ledgers: HistoryLedgers, prefix: string, client: Trading212Client, kind: K, start: Date | undefined, pages: number, ticker?: string):
    Promise<{ collected: Collected<HistoryItemOf<K>>; limited: boolean }> {
    const time = (item: HistoryItemOf<K>) => itemTime(kind, item);
    const kept = await ledgers.load<HistoryItemOf<K>>(prefix, kind, time);
    const had = kept?.items.length ? kept : undefined;
    // This read's horizon, taken before it reads: what is final now cannot come in above it later.
    const horizon = await this.horizon(client, kind, kept?.meta);
    const known = new Set((had?.items ?? []).map((item) => recordKey(kind, item)));
    const scanTo = had?.meta.horizon ? Date.parse(had.meta.horizon) : undefined;
    let budget = pages;
    let limited = false;
    // Past the first page, a limit that resets later than a read waits stops the read, keeping what it read.
    const read = (next?: string) => client.getHistoryPage(kind, next).catch((error: unknown) => {
      if (budget < pages && error instanceof Trading212ApiError && error.status === 429) { limited = true; return undefined; }
      throw error;
    });

    // The newest pages: past the last read's horizon when something is kept, to the window's start when nothing is.
    const fresh: HistoryItemOf<K>[] = [];
    let next: string | null = null;
    let reachedKept = false;
    let scanned = false;
    let ended = false;
    while (budget > 0) {
      const page = await read(next ?? undefined);
      if (!page) break;
      budget -= 1;
      for (const item of page.items as HistoryItemOf<K>[]) {
        if (known.has(recordKey(kind, item))) reachedKept = true;
        else fresh.push(item);
      }
      next = page.nextPagePath ?? null;
      if (!next) { ended = true; break; }
      const lowest = Math.min(...(page.items as HistoryItemOf<K>[]).map((item) => positionTime(kind, item)).filter(Number.isFinite));
      if (had) {
        if (reachedKept && (scanTo === undefined || lowest < scanTo)) { scanned = true; break; }
      } else if (start !== undefined && lowest < start.getTime()) break;
    }

    let added = fresh;
    let meta: Pick<LedgerMeta, "next" | "complete" | "horizon">;
    if (!had) {
      meta = { next: ended ? null : next, complete: ended, ...(horizon ? { horizon } : {}) };
    } else if (scanned || ended) {
      meta = { next: had.meta.next, complete: had.meta.complete || (ended && !reachedKept), ...(horizon ? { horizon } : {}) };
    } else if (reachedKept) {
      // Past what is kept but not down to the last horizon: what was read is added, and the next read scans again.
      meta = { next: had.meta.next, complete: had.meta.complete, ...(had.meta.horizon ? { horizon: earlier(had.meta.horizon, horizon) } : {}) };
    } else {
      // More new records than the read reached, or cut short before it reached any kept: whether records were missed
      // in between is not known, so nothing is added; what is kept and what was read are returned, as cut short.
      const items = union(kind, [...fresh, ...had.items], time);
      return { collected: { items: inWindow(kind, items, start, ticker), truncated: true }, limited };
    }

    // Further back, from where the last read stopped, until the window's start is reached.
    let items = union(kind, [...added, ...(had?.items ?? [])], time);
    const reached = () => {
      const oldest = items.map(time).filter(Number.isFinite).at(-1);
      return start !== undefined && oldest !== undefined && oldest < start.getTime();
    };
    while (budget > 0 && !limited && !meta.complete && meta.next && !reached()) {
      const page = await read(meta.next).catch((error: unknown) => {
        // Refused outright (not the limit, not a network or server failure): the cursor no longer works.
        if (error instanceof Trading212ApiError && error.status >= 400 && error.status < 500) return null;
        return undefined;
      });
      if (page === null) {
        // The way back no longer works (a cursor Trading 212 refuses): start the ledger again on the next read,
        // rather than fail every read from now on.
        await ledgers.clear(prefix);
        return { collected: { items: inWindow(kind, items, start, ticker), truncated: true }, limited };
      }
      if (!page) break;
      budget -= 1;
      added = [...added, ...(page.items as HistoryItemOf<K>[])];
      items = union(kind, [...items, ...(page.items as HistoryItemOf<K>[])], time);
      meta = { ...meta, next: page.nextPagePath ?? null, complete: !page.nextPagePath };
    }
    items = await ledgers.add(prefix, kind, kept, added, meta, time);
    const truncated = !meta.complete && !reached();
    return { collected: { items: inWindow(kind, items, start, ticker), truncated }, limited };
  }

  /**
   * The time before which every record is final now. For orders, the creation of the oldest order still open (it is
   * placed in the history by when it was made, and could fill later) or a few days back, whichever is earlier; for
   * dividends and cash, a few days back. When the open orders cannot be read, the last read's time is used instead,
   * as no order made since it can be below it.
   */
  private async horizon(client: Trading212Client, kind: HistoryKind, last: LedgerMeta | undefined): Promise<string> {
    let at = Date.now() - SETTLE_MS;
    if (kind === "orders") {
      const open = await client.getOrders().catch(() => undefined);
      if (open) for (const order of open) { const made = order.createdAt ? Date.parse(order.createdAt) : NaN; if (Number.isFinite(made)) at = Math.min(at, made); }
      else at = Math.min(at, ...[last?.horizon, last?.updatedAt].map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite));
    }
    return new Date(at).toISOString();
  }

  /** `onRead` is handed the positions and instruments read, for a caller that needs them too (risk by holding). */
  async allocation(environment: TradingEnvironment, limits?: Partial<AllocationLimits>, onRead?: (read: { positions: Position[]; instruments: Instrument[] }) => void): Promise<AllocationAnalysis> {
    const client = this.client(environment);
    const [account, positions, instruments] = await Promise.all([client.getAccountSummary(), client.getPositions(), this.deps.instruments(environment).catch(() => [])]);
    onRead?.({ positions, instruments });
    return analyzeAllocation(environment, account, positions, instruments, { ...DEFAULT_ALLOCATION_LIMITS, ...Object.fromEntries(Object.entries(limits ?? {}).filter(([, value]) => value !== undefined)) });
  }

  /**
   * `readValues` gives the account values TradePilot recorded in the window for one Trading 212 account, for
   * the value chart and the time-weighted return.
   */
  /** `onHistory` is handed the orders and dividends read, for a caller that needs them too (gains by instrument). */
  async performance(environment: TradingEnvironment, window: HistoryWindow, maxPages?: number, readValues?: (account: number | undefined) => Promise<ValuePoint[]>,
    onHistory?: (read: { orders: Collected<HistoryOrderItem>; dividends: Collected<HistoryDividendItem> }) => void): Promise<PerformanceSummary> {
    const client = this.client(environment);
    const account: AccountSummary = await client.getAccountSummary();
    // Only this account's days: after a switch of keys, the old account's days would mix with its history.
    const values = readValues ? await readValues(typeof account.id === "number" ? account.id : undefined).catch(() => []) : [];
    const valuedAt = new Date();
    const orders = await this.collect(environment, "orders", window, maxPages);
    const dividends = await this.collect(environment, "dividends", window, maxPages);
    const transactions = await this.collect(environment, "transactions", window, maxPages);
    onHistory?.({ orders, dividends });
    return summarizePerformance({
      environment, account, window, now: valuedAt,
      orders: orders.items, dividends: dividends.items, transactions: transactions.items,
      truncated: orders.truncated || dividends.truncated || transactions.truncated,
      transactionsTruncated: transactions.truncated,
      ...(values.length ? { values } : {}),
    });
  }

  async income(environment: TradingEnvironment, window: HistoryWindow, maxPages?: number): Promise<IncomeSummary> {
    const client = this.client(environment);
    const [account, positions] = [await client.getAccountSummary(), await client.getPositions()];
    // Trailing-12-month income needs a year of history even for shorter windows, and the expected dividends their
    // paydays since the first day of this month a year ago.
    const yearAgo = new Date(Math.min(window.to.getTime() - 365 * 86_400_000, scheduleStart(window.to.getTime())));
    const fetchWindow = { to: window.to, ...(window.from && window.from < yearAgo ? { from: window.from } : window.from ? { from: yearAgo } : {}) };
    const dividends = await this.collect(environment, "dividends", fetchWindow, maxPages);
    const transactions = await this.collect(environment, "transactions", fetchWindow, maxPages);
    return summarizeIncome({
      environment, accountCurrency: account.currency ?? "", window,
      dividends: dividends.items, transactions: transactions.items, positions,
      truncated: dividends.truncated || transactions.truncated, now: new Date(),
    });
  }

  /**
   * One tax year's sales, dividends, interest and costs. `year` is the calendar year the tax year starts in
   * (the latest one that has started by default); `yearStart` is its first day as MM-DD (UK: 04-06).
   */
  async taxYear(environment: TradingEnvironment, options: { year?: number; yearStart?: string; timeZone?: string; maxPages?: number } = {}, now = new Date()): Promise<TaxYearSummary> {
    const start = parseYearStart(options.yearStart);
    if (options.yearStart?.trim() && start.text !== options.yearStart.trim()) fail("INVALID_INPUT", "yearStart must be a real month and day as MM-DD, such as 04-06", { field: "yearStart" });
    const timeZone = options.timeZone?.trim() || "UTC";
    if (!validTimeZone(timeZone)) fail("INVALID_INPUT", "timeZone must be an IANA time zone such as Europe/London", { field: "timeZone" });
    const year = options.year ?? currentTaxYear(start, now, timeZone);
    const window = taxYearWindow(year, start, timeZone);
    if (window.from.getTime() > now.getTime()) fail("INVALID_INPUT", `The tax year starting ${window.from.toISOString().slice(0, 10)} has not started yet`, { field: "year", year });
    const client = this.client(environment);
    const account: AccountSummary = await client.getAccountSummary();
    const fetchWindow = { from: window.from, to: window.to.getTime() > now.getTime() ? now : window.to };
    const orders = await this.collect(environment, "orders", fetchWindow, options.maxPages);
    const dividends = await this.collect(environment, "dividends", fetchWindow, options.maxPages);
    const transactions = await this.collect(environment, "transactions", fetchWindow, options.maxPages);
    return summarizeTaxYear({
      environment, accountCurrency: account.currency ?? "", year, yearStart: start, timeZone, now,
      orders: orders.items, dividends: dividends.items, transactions: transactions.items,
      truncated: orders.truncated || dividends.truncated || transactions.truncated,
    });
  }

  /**
   * Dividends and cash movements (deposits, withdrawals, interest, fees) one by one, newest first,
   * with totals per type. `types` takes DIVIDEND and Trading 212's transaction types; a ticker limits it to dividends.
   */
  async cashHistory(environment: TradingEnvironment, window: HistoryWindow, options: { ticker?: string; types?: string[]; limit?: number; maxPages?: number } = {}) {
    let exact: string | undefined;
    if (options.ticker?.trim()) {
      try {
        exact = resolveInstrumentFromList(await this.deps.instruments(environment), options.ticker).ticker;
      } catch {
        exact = undefined;
      }
    }
    const types = new Set((options.types ?? []).map((type) => type.trim().toUpperCase()).filter(Boolean));
    const wantDividends = !types.size || types.has("DIVIDEND");
    const wantCash = !options.ticker?.trim() && (!types.size || [...types].some((type) => type !== "DIVIDEND"));
    const [dividends, transactions] = await Promise.all([
      wantDividends ? this.collect(environment, "dividends", window, options.maxPages, exact) : undefined,
      wantCash ? this.collect(environment, "transactions", window, options.maxPages) : undefined,
    ]);
    const wanted = options.ticker?.trim().toUpperCase();
    const inWindow = (time: number) => Number.isFinite(time) && time <= window.to.getTime() && (!window.from || time >= window.from.getTime());
    const items: CashHistoryItem[] = [
      ...(dividends?.items ?? [])
        .filter((item) => !wanted || (exact ? (item.ticker ?? item.instrument?.ticker) === exact : (item.ticker ?? "").toUpperCase().startsWith(wanted)))
        .filter((item) => inWindow(itemTime("dividends", item)))
        .map((item) => ({
          date: item.paidOn ?? "",
          type: "DIVIDEND",
          amount: item.amount ?? 0,
          currency: item.currency ?? "",
          ...(item.ticker ?? item.instrument?.ticker ? { ticker: item.ticker ?? item.instrument?.ticker } : {}),
          ...(item.instrument?.name ? { name: item.instrument.name } : {}),
          ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
          ...(item.grossAmountPerShare === undefined ? {} : { grossPerShare: item.grossAmountPerShare, perShareCurrency: item.tickerCurrency ?? "" }),
          ...(item.type ? { subtype: item.type } : {}),
          ...(item.reference ? { reference: item.reference } : {}),
        })),
      ...(transactions?.items ?? [])
        .filter((item) => !types.size || types.has(String(item.type ?? "").toUpperCase()))
        .filter((item) => inWindow(itemTime("transactions", item)))
        .map((item) => ({
          date: item.dateTime ?? "",
          type: String(item.type ?? "OTHER").toUpperCase(),
          amount: item.amount ?? 0,
          currency: item.currency ?? "",
          ...(item.reference ? { reference: item.reference } : {}),
        })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const totals: Record<string, number> = {};
    for (const item of items) totals[item.type] = Math.round(((totals[item.type] ?? 0) + item.amount) * 100) / 100;
    return {
      kind: "cash_history" as const,
      environment,
      items: items.slice(0, Math.max(1, Math.min(500, options.limit ?? 100))),
      count: items.length,
      totals,
      currency: items.find((item) => item.currency)?.currency ?? "",
      truncated: !!(dividends?.truncated || transactions?.truncated),
      timestamp: new Date().toISOString(),
    };
  }

  async tradeHistory(environment: TradingEnvironment, window: HistoryWindow, ticker?: string, limit = 50, maxPages?: number, includeUnfilled = false) {
    // A name or symbol resolves to the exact ticker, which Trading 212 filters on its side, so a rarely
    // traded instrument is not lost past the page limit. One it no longer lists falls back to a prefix match.
    let exact: string | undefined;
    if (ticker?.trim()) {
      try {
        exact = resolveInstrumentFromList(await this.deps.instruments(environment), ticker).ticker;
      } catch {
        exact = undefined;
      }
    }
    const collected = await this.collect(environment, "orders", window, maxPages, exact);
    const wanted = ticker?.trim().toUpperCase();
    const matches = (value: string) => exact ? value === exact.toUpperCase() : value === wanted || value.startsWith(`${wanted}_`);
    const inWindow = collected.items
      .filter((item) => !wanted || matches((item.order?.ticker ?? item.order?.instrument?.ticker ?? "").toUpperCase()))
      .filter((item) => {
        const time = itemTime("orders", item);
        return Number.isFinite(time) && time <= window.to.getTime() && (!window.from || time >= window.from.getTime());
      });
    const max = Math.max(1, Math.min(200, limit));
    // Orders that closed without a fill: cancelled, rejected or expired.
    const unfilled = includeUnfilled
      ? inWindow.filter((item) => !item.fill).slice(0, max).map((item) => ({
          ...orderIdOf(item.order?.id),
          ticker: item.order?.ticker ?? item.order?.instrument?.ticker,
          ...(item.order?.instrument?.name ? { name: item.order.instrument.name } : {}),
          side: item.order?.side,
          type: item.order?.type,
          status: item.order?.status,
          createdAt: item.order?.createdAt,
          quantity: item.order?.quantity,
          ...(item.order?.value === undefined ? {} : { value: item.order.value }),
          ...(item.order?.limitPrice === undefined ? {} : { limitPrice: item.order.limitPrice }),
          ...(item.order?.stopPrice === undefined ? {} : { stopPrice: item.order.stopPrice }),
          priceCurrency: item.order?.currency ?? item.order?.instrument?.currency,
          initiatedFrom: item.order?.initiatedFrom,
        }))
      : undefined;
    const fills = inWindow
      .filter((item) => item.fill)
      .slice(0, max)
      .map((item) => ({
        ...orderIdOf(item.order?.id),
        ticker: item.order?.ticker ?? item.order?.instrument?.ticker,
        ...(item.order?.instrument?.name ? { name: item.order.instrument.name } : {}),
        side: item.order?.side,
        type: item.order?.type,
        status: item.order?.status,
        initiatedFrom: item.order?.initiatedFrom,
        filledAt: item.fill?.filledAt,
        ...(item.fill?.type ? { fillType: item.fill.type } : {}),
        quantity: item.fill?.quantity,
        price: item.fill?.price,
        priceCurrency: item.order?.currency ?? item.order?.instrument?.currency,
        netValue: item.fill?.walletImpact?.netValue,
        accountCurrency: item.fill?.walletImpact?.currency,
        realisedProfitLoss: item.fill?.walletImpact?.realisedProfitLoss,
        fxRate: item.fill?.walletImpact?.fxRate,
        costs: (item.fill?.walletImpact?.taxes ?? []).reduce((sum, tax) => sum + Math.abs(tax.quantity ?? 0), 0),
        ...(item.fill?.walletImpact?.taxes?.length ? { costItems: item.fill.walletImpact.taxes.map((tax) => ({ name: tax.name ?? "fee", amount: Math.abs(tax.quantity ?? 0), ...(tax.currency ? { currency: tax.currency } : {}) })) } : {}),
      }));
    return { kind: "trade_history" as const, environment, fills, ...(unfilled ? { unfilled } : {}), truncated: collected.truncated, timestamp: new Date().toISOString() };
  }

  /** Exchange-list reads under way, shared by callers at the same moment (Trading 212 allows one in 30 seconds). */
  private readonly exchangeReads = new Map<TradingEnvironment, Promise<Exchange[]>>();

  private async exchanges(environment: TradingEnvironment) {
    const cached = this.exchangeCache.get(environment);
    if (cached && cached.expiresAt > Date.now()) return cached.exchanges;
    const pending = this.exchangeReads.get(environment);
    if (pending) return pending;
    const read = this.client(environment).getExchanges().then((exchanges) => {
      this.exchangeCache.set(environment, { exchanges, expiresAt: Date.now() + EXCHANGE_CACHE_MS });
      return exchanges;
    }).finally(() => this.exchangeReads.delete(environment));
    this.exchangeReads.set(environment, read);
    return read;
  }

  /** Trading 212's exchanges with their working schedules, cached for ten minutes. */
  schedules(environment: TradingEnvironment): Promise<Exchange[]> {
    return this.exchanges(environment);
  }

  async marketHours(environment: TradingEnvironment, query: string, now = new Date()): Promise<MarketStatus> {
    const instrument = resolveInstrumentFromList(await this.deps.instruments(environment), query);
    return marketStatus(instrument, await this.exchanges(environment), now);
  }

  /** Best-effort market status for order review; never blocks an order when schedule data is unavailable. */
  async tryMarketStatus(environment: TradingEnvironment, instrument: Instrument, now = new Date()): Promise<MarketStatus | undefined> {
    try { return marketStatus(instrument, await this.exchanges(environment), now); } catch { return undefined; }
  }

  listExports(environment: TradingEnvironment): Promise<ExportReport[]> { return this.client(environment).listExports(); }

  requestExport(environment: TradingEnvironment, window: HistoryWindow) {
    const timeFrom = (window.from ?? new Date(window.to.getTime() - 365 * 86_400_000)).toISOString();
    return this.client(environment).requestExport({
      timeFrom, timeTo: window.to.toISOString(),
      dataIncluded: { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true },
    });
  }
}

