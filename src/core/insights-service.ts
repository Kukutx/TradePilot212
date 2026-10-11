// Read-only portfolio insights built from Trading 212 history endpoints.
// Nothing in this file can place, change, or cancel an order.

import type { AccountSummary, Instrument, TradingEnvironment } from "../shared/contracts.js";
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
} from "../shared/history.js";
import { analyzeAllocation, DEFAULT_ALLOCATION_LIMITS, marketStatus, summarizeIncome, summarizePerformance, type AllocationLimits, type HistoryWindow } from "./analytics.js";
import type { RuntimeConfig } from "./config.js";
import { credentialStatus } from "./config.js";
import { fail } from "./errors.js";
import { resolveInstrumentFromList } from "./trading-service.js";
import { Trading212Client, type HistoryKind } from "./trading212-client.js";

export interface InsightsDeps {
  config: RuntimeConfig;
  fetcher?: typeof fetch;
  instruments: (environment: TradingEnvironment) => Promise<Instrument[]>;
}

type HistoryItemOf<K extends HistoryKind> = K extends "orders" ? HistoryOrderItem : K extends "dividends" ? HistoryDividendItem : HistoryTransactionItem;
interface Collected<T> { items: T[]; truncated: boolean }

export const DEFAULT_HISTORY_PAGES = 10;
export const MAX_HISTORY_PAGES = 40;
const HISTORY_CACHE_MS = 60_000;
const EXCHANGE_CACHE_MS = 10 * 60_000;

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
  private exchangeCache = new Map<TradingEnvironment, { expiresAt: number; exchanges: Exchange[] }>();

  constructor(private readonly deps: InsightsDeps) {}

  private client(environment: TradingEnvironment) {
    if (!credentialStatus(this.deps.config)[environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${environment.toUpperCase()} credentials are not configured`);
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
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

    const client = this.client(environment);
    const items: HistoryItemOf<K>[] = [];
    let next: string | undefined;
    let truncated = false;
    for (let page = 0; page < pages; page++) {
      const result = await client.getHistoryPage(kind, next, ticker);
      items.push(...(result.items as HistoryItemOf<K>[]));
      const oldest = result.items.length ? itemTime(kind, result.items[result.items.length - 1]!) : NaN;
      const reachedStart = start !== undefined && Number.isFinite(oldest) && oldest < start.getTime();
      if (!result.nextPagePath || reachedStart) { next = undefined; break; }
      next = result.nextPagePath;
      if (page === pages - 1) truncated = true;
    }
    const value = { items, truncated };
    this.historyCache.set(key, { expiresAt: Date.now() + HISTORY_CACHE_MS, value });
    return value;
  }

  async allocation(environment: TradingEnvironment, limits?: Partial<AllocationLimits>): Promise<AllocationAnalysis> {
    const client = this.client(environment);
    const [account, positions, instruments] = await Promise.all([client.getAccountSummary(), client.getPositions(), this.deps.instruments(environment).catch(() => [])]);
    return analyzeAllocation(environment, account, positions, instruments, { ...DEFAULT_ALLOCATION_LIMITS, ...Object.fromEntries(Object.entries(limits ?? {}).filter(([, value]) => value !== undefined)) });
  }

  async performance(environment: TradingEnvironment, window: HistoryWindow, maxPages?: number): Promise<PerformanceSummary> {
    const client = this.client(environment);
    const account: AccountSummary = await client.getAccountSummary();
    const orders = await this.collect(environment, "orders", window, maxPages);
    const dividends = await this.collect(environment, "dividends", window, maxPages);
    const transactions = await this.collect(environment, "transactions", window, maxPages);
    return summarizePerformance({
      environment, account, window,
      orders: orders.items, dividends: dividends.items, transactions: transactions.items,
      truncated: orders.truncated || dividends.truncated || transactions.truncated,
    });
  }

  async income(environment: TradingEnvironment, window: HistoryWindow, maxPages?: number): Promise<IncomeSummary> {
    const client = this.client(environment);
    const [account, positions] = [await client.getAccountSummary(), await client.getPositions()];
    // Trailing-12-month income needs a year of history even for shorter windows.
    const yearAgo = new Date(window.to.getTime() - 365 * 86_400_000);
    const fetchWindow = { to: window.to, ...(window.from && window.from < yearAgo ? { from: window.from } : window.from ? { from: yearAgo } : {}) };
    const dividends = await this.collect(environment, "dividends", fetchWindow, maxPages);
    const transactions = await this.collect(environment, "transactions", fetchWindow, maxPages);
    return summarizeIncome({
      environment, accountCurrency: account.currency ?? "", window,
      dividends: dividends.items, transactions: transactions.items, positions,
      truncated: dividends.truncated || transactions.truncated,
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
        ticker: item.order?.ticker,
        ...(item.order?.instrument?.name ? { name: item.order.instrument.name } : {}),
        side: item.order?.side,
        type: item.order?.type,
        status: item.order?.status,
        initiatedFrom: item.order?.initiatedFrom,
        filledAt: item.fill?.filledAt,
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

  private async exchanges(environment: TradingEnvironment) {
    const cached = this.exchangeCache.get(environment);
    if (cached && cached.expiresAt > Date.now()) return cached.exchanges;
    const exchanges = await this.client(environment).getExchanges();
    this.exchangeCache.set(environment, { exchanges, expiresAt: Date.now() + EXCHANGE_CACHE_MS });
    return exchanges;
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

