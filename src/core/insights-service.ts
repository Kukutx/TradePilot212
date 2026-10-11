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

export function parseWindow(input: { from?: string; to?: string; period?: "1m" | "3m" | "ytd" | "1y" | "all" }, now = new Date()): HistoryWindow {
  const to = input.to ? new Date(input.to) : now;
  if (Number.isNaN(to.getTime())) fail("INVALID_INPUT", "to must be an ISO date-time", { field: "to" });
  if (input.from) {
    const from = new Date(input.from);
    if (Number.isNaN(from.getTime()) || from > to) fail("INVALID_INPUT", "from must be an ISO date-time before to", { field: "from" });
    return { from, to };
  }
  const day = 86_400_000;
  switch (input.period ?? "all") {
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
  async collect<K extends HistoryKind>(environment: TradingEnvironment, kind: K, window: HistoryWindow, maxPages = DEFAULT_HISTORY_PAGES): Promise<Collected<HistoryItemOf<K>>> {
    const pages = Math.max(1, Math.min(MAX_HISTORY_PAGES, Math.floor(maxPages)));
    const key = `${environment}:${kind}:${window.from?.toISOString() ?? "all"}:${pages}`;
    const cached = this.historyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as Collected<HistoryItemOf<K>>;

    const client = this.client(environment);
    const items: HistoryItemOf<K>[] = [];
    let next: string | undefined;
    let truncated = false;
    for (let page = 0; page < pages; page++) {
      const result = await client.getHistoryPage(kind, next);
      items.push(...(result.items as HistoryItemOf<K>[]));
      const oldest = result.items.length ? itemTime(kind, result.items[result.items.length - 1]!) : NaN;
      const reachedStart = window.from !== undefined && Number.isFinite(oldest) && oldest < window.from.getTime();
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

  async tradeHistory(environment: TradingEnvironment, window: HistoryWindow, ticker?: string, limit = 50, maxPages?: number) {
    const collected = await this.collect(environment, "orders", window, maxPages);
    const wanted = ticker?.trim().toUpperCase();
    const fills = collected.items
      .filter((item) => item.fill)
      .filter((item) => !wanted || (item.order?.ticker ?? "").toUpperCase() === wanted || (item.order?.ticker ?? "").toUpperCase().startsWith(`${wanted}_`))
      .filter((item) => {
        const time = itemTime("orders", item);
        return Number.isFinite(time) && time <= window.to.getTime() && (!window.from || time >= window.from.getTime());
      })
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((item) => ({
        ticker: item.order?.ticker,
        side: item.order?.side,
        type: item.order?.type,
        status: item.order?.status,
        initiatedFrom: item.order?.initiatedFrom,
        filledAt: item.fill?.filledAt,
        quantity: item.fill?.quantity,
        price: item.fill?.price,
        netValue: item.fill?.walletImpact?.netValue,
        realisedProfitLoss: item.fill?.walletImpact?.realisedProfitLoss,
        fxRate: item.fill?.walletImpact?.fxRate,
        costs: (item.fill?.walletImpact?.taxes ?? []).reduce((sum, tax) => sum + Math.abs(tax.quantity ?? 0), 0),
      }));
    return { kind: "trade_history" as const, environment, fills, truncated: collected.truncated, timestamp: new Date().toISOString() };
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

