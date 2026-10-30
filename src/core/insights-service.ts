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
import { summarizeExport, type ExportSummary } from "./export-csv.js";
import { accountName, ledgerPrefix, recordKey, SETTLE_MS, union, type HistoryLedgers, type LedgerPending, type LedgerSegment } from "./history-ledger.js";

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

/** Whether the newest run of the ledger reaches back to the window's start (or is the whole history). */
async function covers(ledgers: HistoryLedgers, prefix: string, start: Date | undefined): Promise<boolean> {
  const segment = (await ledgers.meta(prefix))?.segments[0];
  return segment !== undefined && reaches(segment, start);
}

const reaches = (segment: LedgerSegment, start: Date | undefined) =>
  segment.complete || (start !== undefined && segment.bottom !== undefined && Date.parse(segment.bottom) < start.getTime());

/** History over a shorter span than this is read as it always was: a page or two, with nothing to keep. */
const LEDGER_SPAN_MS = 60 * 86_400_000;
/** An order no longer open that its instrument's history does not list is looked for this long, then let go. */
const MISSING_MS = 2 * 86_400_000;
/** Trading 212 refuses a path it no longer knows with one of these. */
const REFUSED = new Set([400, 404, 410]);

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
    if (ledgers && prefix && long && (!ticker || await covers(ledgers, prefix, start).catch(() => false))) {
      // A store that fails (full, unreachable) costs the ledger, not the read: it is read as it was before.
      const value = await ledgers.exclusive(prefix, () => this.fromLedger(ledgers, prefix, client, kind, start, pages, ticker))
        .catch((error: unknown) => { if (error instanceof Trading212ApiError) throw error; return undefined; });
      if (value) {
        // Cut short, it is not kept either: asking again goes on further back.
        if (!value.limited && !value.collected.truncated && (this.historyGeneration.get(environment) ?? 0) === generation) this.historyCache.set(key, { expiresAt: Date.now() + HISTORY_CACHE_MS, value: value.collected });
        return value.collected;
      }
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
   * The history from the ledger, or nothing when it cannot be used this time (the open orders cannot be read). A new
   * segment is begun at the newest record and read down until it joins the one below; then the orders that were
   * open at the last read and are no longer are looked for; then the newest segment is read further back, until it
   * reaches the window's start, the account's first record or the page budget. What is read is added to the ledger,
   * and the records in the window are returned (one instrument's, with `ticker`).
   */
  private async fromLedger<K extends HistoryKind>(ledgers: HistoryLedgers, prefix: string, client: Trading212Client, kind: K, start: Date | undefined, pages: number, ticker?: string):
    Promise<{ collected: Collected<HistoryItemOf<K>>; limited: boolean } | undefined> {
    const times = { time: (item: HistoryItemOf<K>) => itemTime(kind, item), place: (item: HistoryItemOf<K>) => positionTime(kind, item) };
    const readAt = new Date().toISOString();
    // The orders open now, read before the history: one made before this read and not in what it reads is one of them.
    const open = kind === "orders" ? await client.getOrders().catch(() => undefined) : [];
    if (!open) return undefined;
    const kept = await ledgers.load<HistoryItemOf<K>>(prefix, kind, times);
    const known = new Set((kept?.items ?? []).map((item) => recordKey(kind, item)));
    const added: HistoryItemOf<K>[] = [];
    const keep = (items: HistoryItemOf<K>[]) => {
      for (const item of items) { const key = recordKey(kind, item); if (!known.has(key)) { known.add(key); added.push(item); } }
    };
    let budget = pages;
    let limited = false;
    // Past the first request, a failure (the limit, a server error) stops the read, keeping what it read; a path
    // Trading 212 no longer knows is "refused".
    const read = async (next: string | undefined, filter?: string) => {
      const first = budget === pages;
      budget -= 1;
      try {
        return await client.getHistoryPage(kind, next, filter);
      } catch (error) {
        if (first) throw error;
        if (next && error instanceof Trading212ApiError && REFUSED.has(error.status)) return "refused" as const;
        limited = true;
        return undefined;
      }
    };

    // The segment this read begins, newest first, then those kept. `next` undefined: not read yet, from the newest.
    const segments: Array<Omit<LedgerSegment, "next"> & { next: string | null | undefined }> = [{ readAt, next: undefined, complete: false }, ...(kept?.meta.segments ?? [])];
    let begun = true;
    /** Where the run read before its way back was refused reached: what this read returns stops there. */
    let refusedAt: string | undefined;
    /** Reads the next page of the newest segment, and joins it to the one below once it is past where that began. */
    const step = async (): Promise<boolean> => {
      const segment = segments[0]!;
      const page = await read(segment.next ?? undefined);
      if (page === "refused") {
        refusedAt = segment.bottom;
        // The way back no longer works: the segment is forgotten (its records stay), and in its place is one that
        // reaches nothing, so the runs below are not taken as joined to the newest records; later reads read past it.
        segments.splice(0, 1, { readAt, next: null, complete: false });
        limited = true;
        return false;
      }
      if (!page) return false;
      const items = page.items as HistoryItemOf<K>[];
      // The newest page empty while records are kept is not an account with no history: a failed answer. (Empty
      // through a path further back, it is the end: Trading 212 may give a path after a full last page.)
      if (!items.length && !page.nextPagePath && segment.next === undefined && known.size) { limited = true; return false; }
      keep(items);
      const lowest = Math.min(...items.map(times.place).filter(Number.isFinite));
      if (Number.isFinite(lowest) && (segment.bottom === undefined || lowest < Date.parse(segment.bottom))) segment.bottom = new Date(lowest).toISOString();
      segment.next = page.nextPagePath ?? null;
      if (!segment.next) segment.complete = true;
      while (segments[1]) {
        const below = segments[1];
        if (segment.complete) { segments.splice(1); break; }
        if (segment.bottom === undefined || Date.parse(segment.bottom) >= Date.parse(below.readAt) - SETTLE_MS) break;
        // Past where the segment below began, less the records that could have come in above it since: one run.
        begun = false;
        if (below.bottom !== undefined && Date.parse(below.bottom) < Date.parse(segment.bottom)) Object.assign(segment, { bottom: below.bottom, next: below.next, complete: below.complete });
        segments.splice(1, 1);
      }
      return true;
    };
    const reached = () => reaches({ ...segments[0]!, next: segments[0]!.next ?? null }, start);
    const more = () => budget > 0 && !limited && !segments[0]!.complete && segments[0]!.next !== null && !reached();

    // The newest records, down to where the last read began.
    while (begun && segments.length > 1 && more()) if (!await step()) break;
    // The orders open at the last read that are no longer: each in its instrument's history, by when it was made.
    const pending: LedgerPending[] = [];
    let unresolved = false;
    const openIds = new Set(open.map((order) => String(order.id)));
    // Records of an order kept: one open may already have a fill listed, so it is found once it has more than then.
    const recordsOf = (id: string) => { let count = 0; for (const key of known) if (key.startsWith(`o:${id}:`)) count += 1; return count; };
    for (const order of kept?.meta.pending ?? []) {
      const listed = (id: string) => recordsOf(id) > (order.seen ?? 0);
      if (openIds.has(order.id) || listed(order.id)) continue;
      let next: string | undefined;
      let searched = false;
      while (budget > 0 && !limited) {
        const page = await read(next, order.ticker);
        if (!page || page === "refused") break;
        const items = page.items as HistoryItemOf<K>[];
        keep(items);
        const lowest = Math.min(...items.map(times.place).filter(Number.isFinite));
        // On to below when it was made: an order's fills are placed together, and may run onto the next page.
        if (!page.nextPagePath || lowest < Date.parse(order.createdAt)) { searched = true; break; }
        next = page.nextPagePath;
      }
      const counts = !ticker || order.ticker === ticker;
      if (listed(order.id)) continue;
      if (!searched) { unresolved ||= counts; pending.push(order); continue; }
      // Not listed yet: looked for again on later reads, for a while, and until then the history may lack its fill.
      const since = order.missingSince ?? readAt;
      if (Date.parse(readAt) - Date.parse(since) < MISSING_MS) { unresolved ||= counts; pending.push({ ...order, missingSince: since }); }
    }
    for (const order of open) {
      if (order.id === undefined || !order.ticker || !order.createdAt || pending.some((item) => item.id === String(order.id))) continue;
      const seen = recordsOf(String(order.id));
      pending.push({ id: String(order.id), ticker: order.ticker, createdAt: order.createdAt, ...(seen ? { seen } : {}) });
    }
    // Further back, until the window's start.
    while (more()) if (!await step()) break;

    const stored = segments.map((segment) => ({ ...segment, next: segment.next ?? null }));
    const saved = await ledgers.add(prefix, kind, kept, added, { segments: stored, pending }, times);
    const newest = saved.meta.segments[0];
    const whole = newest !== undefined && reaches(newest, start);
    // Cut short of the window's start, the records below the newest run are left out, as there may be a gap above
    // them: what is returned is the newest records without a hole, as a read straight from Trading 212 gives.
    const bottom = newest?.bottom ?? refusedAt;
    const floor = bottom !== undefined ? Date.parse(bottom) : undefined;
    const items = whole || floor === undefined ? saved.items : saved.items.filter((item) => !(times.place(item) < floor) || !(times.time(item) < floor));
    return { collected: { items: inWindow(kind, items, start, ticker), truncated: unresolved || !whole }, limited };
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

  /**
   * Asks Trading 212 for a CSV report of the window, unless one of the same period (its start on the same day, its
   * end within a day) is queued, being built or finished: that one is given instead, as `reused`, rather than a
   * second report of the same records (Trading 212 allows one request in 30 seconds).
   */
  async requestExport(environment: TradingEnvironment, window: HistoryWindow): Promise<{ reportId: number; reused?: ExportReport }> {
    const timeFrom = (window.from ?? new Date(window.to.getTime() - 365 * 86_400_000)).toISOString();
    const timeTo = window.to.toISOString();
    const client = this.client(environment);
    const reports = await client.listExports().catch(() => [] as ExportReport[]);
    const same = reports.find((report) => !/fail|cancel/i.test(report.status ?? "") && report.timeFrom && report.timeTo
      && report.timeFrom.slice(0, 10) === timeFrom.slice(0, 10) && Math.abs(Date.parse(report.timeTo) - Date.parse(timeTo)) <= 86_400_000);
    if (same) return { reportId: same.reportId, reused: same };
    return client.requestExport({
      timeFrom, timeTo,
      dataIncluded: { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true },
    });
  }

  /**
   * Downloads a finished report (the newest, or `reportId`) and reads it: what each kind of row adds up to, and the
   * charges, interest and dividends it holds. A report not finished yet gives its status. Read files are kept for the
   * process's life: a finished report does not change.
   */
  async readExport(environment: TradingEnvironment, reportId?: number): Promise<ExportRead> {
    const reports = await this.client(environment).listExports();
    const finished = (report: ExportReport) => /finish|complete|ready/i.test(report.status ?? "") && Boolean(report.downloadLink);
    const report = reportId !== undefined
      ? reports.find((item) => item.reportId === reportId)
      : [...reports].filter(finished).sort((a, b) => b.reportId - a.reportId)[0];
    if (!report) fail("INVALID_INPUT", reportId !== undefined ? `Trading 212 has no report ${reportId}.` : "Trading 212 has no finished report yet: request one, then read it once it is finished.");
    if (!finished(report)) return { report };
    const key = `${environment}:${report.reportId}`;
    let read = this.exportReads.get(key);
    if (!read) {
      read = this.download(report.downloadLink!).then(summarizeExport);
      this.exportReads.set(key, read);
      read.catch(() => this.exportReads.delete(key));
      if (this.exportReads.size > 20) this.exportReads.delete(this.exportReads.keys().next().value!);
    }
    return { report, ...(await read) };
  }

  private readonly exportReads = new Map<string, Promise<ReturnType<typeof summarizeExport>>>();

  /** The report's file, from Trading 212's storage: over https, no API key sent, MAX_EXPORT_BYTES at most. */
  private async download(link: string): Promise<string> {
    const url = new URL(link);
    if (url.protocol !== "https:") fail("BROKER_REQUEST_FAILED", "The report's download link is not https, so it is not read.");
    const response = await (this.deps.fetcher ?? globalThis.fetch)(url.toString(), { redirect: "follow" });
    if (!response.ok) fail("BROKER_REQUEST_FAILED", `The report could not be downloaded (HTTP ${response.status}); its link may have expired: list the reports again for a new one.`);
    const size = Number(response.headers.get("content-length") ?? NaN);
    if (size > MAX_EXPORT_BYTES) fail("BROKER_REQUEST_FAILED", `The report is ${Math.round(size / 1_000_000)} MB, more than TradePilot reads; request a shorter period.`);
    const text = await response.text();
    if (text.length > MAX_EXPORT_BYTES) fail("BROKER_REQUEST_FAILED", "The report is larger than TradePilot reads; request a shorter period.");
    return text;
  }
}

/** A report and, once finished, what it holds. */
export interface ExportRead {
  report: ExportReport;
  summary?: ExportSummary;
  records?: Array<Record<string, string>>;
}

/** The largest report file read. */
const MAX_EXPORT_BYTES = 25_000_000;

