import type {
  AccountSummary,
  ActivityEvent,
  ActivityType,
  CancelPreview,
  DashboardPayload,
  EnrichedTradeCandidate,
  ExecutionVerificationResult,
  Instrument,
  OrderDraft,
  OrderExecutionResult,
  OrderIntent,
  OrderNotice,
  OrderPreview,
  PendingOrder,
  Position,
  ResolvedOrderIntent,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts.js";
import type { BasketDraftPayload, BasketExecutionResult, BasketPreview, BasketPurpose, PolicyCheck, ProtectiveLink, RebalancePlan, RebalanceTarget } from "../shared/automation.js";
import type { MarketStatus } from "../shared/history.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import { planRebalance, type RebalanceOptions } from "./rebalance.js";
import { addUsage, blockingChecks, EMPTY_USAGE, evaluatePolicy, usageKey, type DailyUsage } from "./policy.js";
import type { StateStore } from "./state-store.js";
import { ExecutionStatusUnknownError, Trading212ApiError, Trading212Client } from "./trading212-client.js";
import { randomToken } from "./web-utils.js";

type Audit = (event: string, details: Record<string, unknown>) => Promise<void>;
interface PendingBasket {
  kind: "basket";
  environment: TradingEnvironment;
  purpose: BasketPurpose;
  title: string;
  drafts: OrderDraft[];
  independentSells: boolean;
  planId?: string;
}
type Pending = { kind: "order"; draft: OrderDraft } | { kind: "cancel"; environment: TradingEnvironment; orderId: string } | PendingBasket;
interface Snapshot { instruments: Instrument[]; positions: Position[]; account: AccountSummary }
export interface BasketRequest {
  environment: TradingEnvironment;
  purpose: BasketPurpose;
  title: string;
  drafts: OrderDraft[];
  /** Protective orders cover the same shares, so their sells are checked one by one, not summed. */
  independentSells?: boolean;
  planId?: string;
  notes?: string[];
}
export const MAX_BASKET_LEGS = 20;
type VerificationRecord =
  | { kind: "order"; environment: TradingEnvironment; draft: OrderDraft; baselineQuantity: number; createdAt: string }
  | { kind: "cancel"; environment: TradingEnvironment; orderId: string; createdAt: string };
export interface InstrumentCacheEntry { expiresAt: number; instruments: Instrument[] }
export type InstrumentCache = Map<TradingEnvironment, InstrumentCacheEntry>;
export interface TradingServiceDeps {
  config: RuntimeConfig;
  store: StateStore;
  audit?: Audit;
  fetcher?: typeof fetch;
  instrumentCache?: InstrumentCache;
  /** Optional exchange-session lookup used to warn about orders placed while the market is closed. */
  marketStatus?: (environment: TradingEnvironment, instrument: Instrument) => Promise<MarketStatus | undefined>;
  /** Called after a basket created for a standing plan has been executed. */
  afterBasket?: (planId: string, result: BasketExecutionResult) => Promise<void>;
  /** Optional webhook for notable events; it filters the types itself and never throws. */
  notify?: (event: ActivityEvent) => Promise<void>;
}

function positiveNumber(name: string, value?: number): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

function floorQuantity(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

const ACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_STALE_SECONDS = 300;
const USAGE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 400 * 24 * 60 * 60 * 1000;

function orderIdOf(order: unknown): string | undefined {
  const id = order && typeof order === "object" ? (order as { id?: unknown }).id : undefined;
  return typeof id === "number" || (typeof id === "string" && id) ? String(id) : undefined;
}

function dateAgeSeconds(value?: string, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor((now - parsed) / 1000));
}

function closeQuantity(a: number, b: number): boolean {
  const tolerance = Math.max(1e-8, Math.abs(b) * 1e-6);
  return Math.abs(a - b) <= tolerance;
}

function orderQuantity(order: PendingOrder): number | undefined {
  return typeof order.quantity === "number" && Number.isFinite(order.quantity) ? Math.abs(order.quantity) : undefined;
}

export function resolveInstrumentFromList(instruments: Instrument[], query: string): Instrument {
  const norm = (value: string) => value.trim().toUpperCase();
  const q = norm(query);
  if (!q) throw new Error("Ticker, symbol, or instrument name is required");

  const exact = instruments.find((item) => norm(item.ticker) === q);
  if (exact) return exact;

  const symbols = instruments.filter((item) => {
    const ticker = norm(item.ticker);
    return norm(item.shortName ?? "") === q || ticker.startsWith(`${q}_`) || ticker.startsWith(`${q}-`);
  });
  if (symbols.length === 1) return symbols[0]!;
  if (symbols.length > 1) {
    const us = symbols.find((item) => /_US_EQ$/i.test(item.ticker));
    if (us) return us;
    const usd = symbols.filter((item) => norm(item.currencyCode) === "USD");
    if (usd.length === 1) return usd[0]!;
    throw new Error(`Symbol ${query} is ambiguous. Use an exact Trading 212 ticker: ${symbols.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }

  const exactNames = instruments.filter((item) => norm(item.name ?? "") === q);
  if (exactNames.length === 1) return exactNames[0]!;
  if (exactNames.length > 1) {
    const exactStocks = exactNames.filter((item) => norm(item.type ?? "") === "STOCK");
    if (exactStocks.length === 1) return exactStocks[0]!;
    const exactUsStocks = exactStocks.filter((item) => /_US_EQ$/i.test(item.ticker));
    if (exactUsStocks.length === 1) return exactUsStocks[0]!;
    const exactUsdStocks = exactStocks.filter((item) => norm(item.currencyCode) === "USD");
    if (exactUsdStocks.length === 1) return exactUsdStocks[0]!;
    throw new Error(`Instrument ${query} is ambiguous. Use an exact ticker: ${exactNames.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }

  const names = instruments.filter((item) => `${item.name ?? ""} ${item.shortName ?? ""}`.toUpperCase().includes(q));
  if (names.length === 1) return names[0]!;
  if (names.length > 1) {
    const stocks = names.filter((item) => norm(item.type ?? "") === "STOCK");
    if (stocks.length === 1) return stocks[0]!;
    const usStocks = stocks.filter((item) => /_US_EQ$/i.test(item.ticker));
    if (usStocks.length === 1) return usStocks[0]!;
    throw new Error(`Instrument ${query} is ambiguous. Use an exact ticker: ${names.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }
  throw new Error(`No Trading 212 instrument matched ${query}`);
}

export function validateOrderAgainstSnapshot(
  draft: OrderDraft,
  instrument: Instrument,
  position: Position | undefined,
  account: AccountSummary,
  config: Pick<RuntimeConfig, "maxOrderNotional" | "maxOrderQuantity">,
) {
  if (!draft.ticker.trim()) throw new Error("Ticker is required");
  positiveNumber("quantity", draft.quantity);

  if (config.maxOrderQuantity > 0 && draft.quantity > config.maxOrderQuantity)
    throw new Error(`Quantity exceeds MAX_ORDER_QUANTITY (${config.maxOrderQuantity})`);
  if (["limit", "stop_limit"].includes(draft.type)) positiveNumber("limitPrice", draft.limitPrice);
  if (["stop", "stop_limit"].includes(draft.type)) positiveNumber("stopPrice", draft.stopPrice);
  if (draft.extendedHours && draft.type !== "market")
    throw new Error("extendedHours is only supported for Market orders by the Trading 212 Public API");
  if (draft.extendedHours && !instrument.extendedHours)
    throw new Error(`${instrument.ticker} does not support extended-hours execution`);
  if (draft.side === "buy" && instrument.maxOpenQuantity && Math.max(0, position?.quantity ?? 0) + draft.quantity > instrument.maxOpenQuantity + Number.EPSILON)
    throw new Error(`Resulting quantity exceeds Trading 212 maxOpenQuantity (${instrument.maxOpenQuantity})`);
  if (draft.side === "sell" && draft.quantity > (position?.quantityAvailableForTrading ?? 0) + Number.EPSILON)
    throw new Error(`Sell quantity ${draft.quantity} exceeds available quantity ${position?.quantityAvailableForTrading ?? 0}`);

  // A Market order's referencePrice comes from the caller, so it must not be able to talk the
  // notional cap down: when the broker reports a current price, the higher of the two is used.
  const marketPrices = [draft.referencePrice, position?.currentPrice].filter((value): value is number => value !== undefined && value > 0);
  const price = draft.type === "limit" || draft.type === "stop_limit"
    ? draft.limitPrice
    : draft.type === "stop"
      ? draft.stopPrice
      : marketPrices.length ? Math.max(...marketPrices) : undefined;
  const estimatedNotional = price && price > 0 ? price * draft.quantity : undefined;

  if (config.maxOrderNotional > 0) {
    if (!estimatedNotional)
      throw new Error("A current referencePrice is required for this Market order while MAX_ORDER_NOTIONAL is enabled. Set MAX_ORDER_NOTIONAL=0 to disable the app-level notional cap.");
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) throw new Error("Estimated order notional is invalid");
    if (estimatedNotional > config.maxOrderNotional)
      throw new Error(`Estimated order notional ${estimatedNotional.toFixed(2)} ${instrument.currencyCode} exceeds MAX_ORDER_NOTIONAL (${config.maxOrderNotional})`);
  }

  const availableCash = account.cash?.availableToTrade;
  const sameCurrency = !!account.currency && account.currency.toUpperCase() === instrument.currencyCode.toUpperCase();
  const cashCheckApplied = draft.side !== "buy" || (sameCurrency && estimatedNotional !== undefined);
  if (draft.side === "buy" && sameCurrency && availableCash !== undefined && estimatedNotional !== undefined && estimatedNotional > availableCash)
    throw new Error(`Estimated order notional ${estimatedNotional.toFixed(2)} exceeds available cash ${availableCash.toFixed(2)} ${account.currency}`);

  return {
    ...(estimatedNotional === undefined ? {} : { estimatedNotional }),
    estimatedNotionalCurrency: instrument.currencyCode,
    cashCheckApplied,
    ...(availableCash === undefined ? {} : { availableCash }),
    ...(account.currency ? { accountCurrency: account.currency } : {}),
  };
}

function sameCurrency(account: AccountSummary, instrument: Instrument) {
  return !!account.currency && account.currency.toUpperCase() === instrument.currencyCode.toUpperCase();
}

export class TradingService {
  private readonly cache: InstrumentCache;

  constructor(private readonly deps: TradingServiceDeps) {
    this.cache = deps.instrumentCache ?? new Map();
  }

  private client(environment: TradingEnvironment) {
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
  }

  async instruments(environment: TradingEnvironment) {
    const cached = this.cache.get(environment);
    if (cached && cached.expiresAt > Date.now()) return cached.instruments;
    const instruments = await this.client(environment).getInstruments();
    this.cache.set(environment, { instruments, expiresAt: Date.now() + 600_000 });
    return instruments;
  }

  /** Current positions only, for the scheduler's price checks. */
  positions(environment: TradingEnvironment): Promise<Position[]> {
    return this.client(environment).getPositions();
  }

  private positionFor(positions: Position[], ticker: string) {
    return positions.find((position) => position.instrument?.ticker.toUpperCase() === ticker.toUpperCase());
  }

  async recordActivity(
    type: ActivityType,
    environment: TradingEnvironment,
    details: Omit<ActivityEvent, "id" | "timestamp" | "environment" | "type"> = {},
  ): Promise<ActivityEvent> {
    const timestamp = new Date().toISOString();
    const event: ActivityEvent = { id: crypto.randomUUID(), timestamp, environment, type, ...details };
    try {
      await this.deps.store.put(`activity:${timestamp}:${event.id}`, event, Date.now() + ACTIVITY_TTL_MS);
      const existing = await this.deps.store.list<ActivityEvent>("activity:");
      if (existing.length > 120) {
        const stale = existing
          .sort((a, b) => a.value.timestamp.localeCompare(b.value.timestamp))
          .slice(0, existing.length - 100);
        await Promise.all(stale.map((item) => this.deps.store.delete(item.key)));
      }
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot activity persistence failed", error: error instanceof Error ? error.message : String(error) }));
    }
    try {
      await this.deps.audit?.(type, { environment, ...details });
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot audit hook failed", error: error instanceof Error ? error.message : String(error) }));
    }
    await this.deps.notify?.(event);
    return event;
  }

  async getActivity(environment?: TradingEnvironment, limit = 12): Promise<ActivityEvent[]> {
    try {
      const entries = await this.deps.store.list<ActivityEvent>("activity:");
      return entries
        .map((item) => item.value)
        .filter((event) => !environment || event.environment === environment)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, Math.max(1, Math.min(limit, 50)));
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot activity read failed", error: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  }

  async searchInstruments(environment: TradingEnvironment, query: string, limit = 20) {
    if (!credentialStatus(this.deps.config)[environment]) return [];
    const q = query.trim().toUpperCase();
    return (await this.instruments(environment))
      .filter((item) => !q || `${item.ticker} ${item.shortName} ${item.name} ${item.isin ?? ""}`.toUpperCase().includes(q))
      .slice(0, limit);
  }

  async getDashboard(environment: TradingEnvironment): Promise<DashboardPayload> {
    const credentials = credentialStatus(this.deps.config);
    if (!credentials[environment]) {
      return {
        kind: "portfolio",
        appName: "TradePilot 212",
        environment,
        credentials,
        account: null,
        positions: [],
        orders: [],
        activity: await this.getActivity(environment),
        timestamp: new Date().toISOString(),
        warning: `${environment.toUpperCase()} credentials are not configured`,
      };
    }
    const client = this.client(environment);
    const [account, positions, orders, activity] = await Promise.all([client.getAccountSummary(), client.getPositions(), client.getOrders(), this.getActivity(environment)]);
    return { kind: "portfolio", appName: "TradePilot 212", environment, credentials, account, positions, orders, activity, timestamp: new Date().toISOString() };
  }

  async getTradePlan(environment: TradingEnvironment, candidates: TradeCandidate[]): Promise<TradePlanPayload> {
    const credentials = credentialStatus(this.deps.config);
    if (!credentials[environment]) {
      return {
        kind: "trade_plan",
        environment,
        credentials,
        account: null,
        timestamp: new Date().toISOString(),
        candidates: candidates.map((candidate) => ({ ...candidate, resolutionError: `${environment.toUpperCase()} credentials are not configured` })),
      };
    }
    const client = this.client(environment);
    const [instruments, positions, account] = await Promise.all([this.instruments(environment), client.getPositions(), client.getAccountSummary()]);
    const enriched: EnrichedTradeCandidate[] = candidates.map((candidate) => {
      try {
        const resolvedInstrument = resolveInstrumentFromList(instruments, candidate.ticker ?? candidate.symbol ?? candidate.name ?? "");
        const position = this.positionFor(positions, resolvedInstrument.ticker);
        return { ...candidate, resolvedInstrument, ...(position ? { heldQuantity: position.quantity, availableToSell: position.quantityAvailableForTrading } : {}) };
      } catch (error) {
        return { ...candidate, resolutionError: error instanceof Error ? error.message : String(error) };
      }
    });
    return { kind: "trade_plan", environment, credentials, candidates: enriched, account, timestamp: new Date().toISOString() };
  }

  async resolveOrderIntent(intent: OrderIntent): Promise<ResolvedOrderIntent> {
    const credentials = credentialStatus(this.deps.config);
    if (!credentials[intent.environment]) throw new Error(`${intent.environment.toUpperCase()} credentials are not configured`);

    const client = this.client(intent.environment);
    const fetchedAt = new Date().toISOString();
    const [instruments, positions, account] = await Promise.all([
      this.instruments(intent.environment),
      client.getPositions(),
      client.getAccountSummary(),
    ]);
    const instrument = resolveInstrumentFromList(instruments, intent.instrument);
    const position = this.positionFor(positions, instrument.ticker);
    const sizing = intent.sizing;
    let quantity: number;
    let note: string;
    let requestedNotional: number | undefined;
    let requestedNotionalCurrency: string | undefined;
    let estimatedQuoteNotional: number | undefined;
    let referencePrice = intent.referencePrice;
    let referencePriceAt = intent.referencePriceAt;

    if (sizing.mode === "quantity") {
      positiveNumber("quantity", sizing.quantity);
      quantity = sizing.quantity;
      note = `Exact quantity: ${quantity} share(s).`;
    } else if (sizing.mode === "cash_percent") {
      if (intent.side !== "buy") throw new Error("cash_percent sizing is only valid for buy orders");
      positiveNumber("percent", sizing.percent);
      if (sizing.percent > 100) throw new Error("cash_percent cannot exceed 100");
      const availableCash = account.cash?.availableToTrade ?? 0;
      if (availableCash <= 0) throw new Error("There is no available cash to size this order");
      const pricingReference = referencePrice
        ?? (intent.type === "limit" || intent.type === "stop_limit" ? intent.limitPrice : undefined)
        ?? (intent.type === "stop" ? intent.stopPrice : undefined)
        ?? position?.currentPrice;
      positiveNumber("referencePrice", pricingReference);
      if (referencePrice === undefined && position?.currentPrice === pricingReference) referencePriceAt = fetchedAt;
      referencePrice ??= pricingReference;
      const accountCurrency = (account.currency || instrument.currencyCode).toUpperCase();
      const instrumentCurrency = instrument.currencyCode.toUpperCase();
      requestedNotional = availableCash * sizing.percent / 100;
      requestedNotionalCurrency = accountCurrency;
      let quoteAmount = requestedNotional;
      if (accountCurrency !== instrumentCurrency) {
        positiveNumber("fxRateToInstrumentCurrency", sizing.fxRateToInstrumentCurrency);
        quoteAmount = requestedNotional * sizing.fxRateToInstrumentCurrency;
      }
      quantity = floorQuantity(quoteAmount / pricingReference);
      if (quantity <= 0) throw new Error("The selected cash percentage is too small to produce a positive quantity");
      estimatedQuoteNotional = pricingReference * quantity;
      note = `Use ${sizing.percent}% of available cash (${requestedNotional.toFixed(2)} ${accountCurrency}) to buy approximately ${quantity} share(s).`;
    } else if (sizing.mode === "position_percent") {
      if (intent.side !== "sell") throw new Error("position_percent sizing is only valid for sell orders");
      positiveNumber("percent", sizing.percent);
      if (sizing.percent > 100) throw new Error("position_percent cannot exceed 100");
      const held = position?.quantity ?? 0;
      const available = position?.quantityAvailableForTrading ?? 0;
      if (held <= 0 || available <= 0) throw new Error(`There is no tradable ${instrument.ticker} position to sell`);
      quantity = sizing.percent === 100 ? held : floorQuantity(held * sizing.percent / 100);
      if (quantity <= 0) throw new Error("The requested position percentage is too small to produce a tradable quantity");
      if (quantity > available + Number.EPSILON)
        throw new Error(`Selling ${sizing.percent}% of the held position requires ${quantity} share(s), but only ${available} are currently tradable. Use an exact quantity or all_available.`);
      if (referencePrice === undefined && position?.currentPrice !== undefined) referencePriceAt = fetchedAt;
      referencePrice ??= position?.currentPrice;
      note = `Sell ${sizing.percent}% of the total held position: ${quantity} share(s).`;
    } else if (sizing.mode === "all_available") {
      if (intent.side !== "sell") throw new Error("all_available sizing is only valid for sell orders");
      const available = position?.quantityAvailableForTrading ?? 0;
      if (available <= 0) throw new Error(`There is no tradable ${instrument.ticker} position to sell`);
      quantity = available;
      if (referencePrice === undefined && position?.currentPrice !== undefined) referencePriceAt = fetchedAt;
      referencePrice ??= position?.currentPrice;
      note = `Sell all currently tradable shares: ${quantity}.`;
    } else {
      positiveNumber("amount", sizing.amount);
      const pricingReference = referencePrice
        ?? (intent.type === "limit" || intent.type === "stop_limit" ? intent.limitPrice : undefined)
        ?? (intent.type === "stop" ? intent.stopPrice : undefined)
        ?? position?.currentPrice;
      positiveNumber("referencePrice", pricingReference);
      if (referencePrice === undefined && position?.currentPrice === pricingReference) referencePriceAt = fetchedAt;
      referencePrice ??= pricingReference;

      const requestedCurrency = (sizing.currency || instrument.currencyCode).trim().toUpperCase();
      const instrumentCurrency = instrument.currencyCode.toUpperCase();
      requestedNotional = sizing.amount;
      requestedNotionalCurrency = requestedCurrency;
      let quoteAmount = sizing.amount;
      if (requestedCurrency !== instrumentCurrency) {
        positiveNumber("fxRateToInstrumentCurrency", sizing.fxRateToInstrumentCurrency);
        quoteAmount = sizing.amount * sizing.fxRateToInstrumentCurrency;
      }
      quantity = floorQuantity(quoteAmount / pricingReference);
      if (quantity <= 0) throw new Error("The requested amount is too small to produce a positive quantity");
      estimatedQuoteNotional = pricingReference * quantity;
      note = requestedCurrency === instrumentCurrency
        ? `${sizing.amount} ${requestedCurrency} target amount resolves to approximately ${quantity} share(s) at ${pricingReference} ${instrumentCurrency}.`
        : `${sizing.amount} ${requestedCurrency} converted at ${sizing.fxRateToInstrumentCurrency} ${instrumentCurrency}/${requestedCurrency} resolves to approximately ${quantity} share(s) at ${pricingReference} ${instrumentCurrency}.`;
    }

    const draft: OrderDraft = {
      environment: intent.environment,
      ticker: instrument.ticker,
      side: intent.side,
      type: intent.type,
      quantity,
      ...(intent.extendedHours === undefined ? {} : { extendedHours: intent.extendedHours }),
      ...(intent.timeValidity === undefined ? {} : { timeValidity: intent.timeValidity }),
      ...(intent.limitPrice === undefined ? {} : { limitPrice: intent.limitPrice }),
      ...(intent.stopPrice === undefined ? {} : { stopPrice: intent.stopPrice }),
      ...(referencePrice === undefined ? {} : { referencePrice }),
      ...(referencePriceAt ? { referencePriceAt } : {}),
      ...(intent.fxRateAt ? { fxRateAt: intent.fxRateAt } : {}),
    };

    // Validate what can be validated now. This remains read-only; no order is submitted.
    validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config);

    return {
      draft,
      instrument,
      sizing,
      ...(account.currency ? { accountCurrency: account.currency } : {}),
      ...(position ? { heldQuantity: position.quantity, availableToSell: position.quantityAvailableForTrading } : {}),
      ...(requestedNotional === undefined ? {} : { requestedNotional }),
      ...(requestedNotionalCurrency === undefined ? {} : { requestedNotionalCurrency }),
      ...(estimatedQuoteNotional === undefined ? {} : { estimatedQuoteNotional }),
      note,
    };
  }

  private async current(draft: OrderDraft) {
    const instrument = resolveInstrumentFromList(await this.instruments(draft.environment), draft.ticker);
    draft.ticker = instrument.ticker;
    const client = this.client(draft.environment);
    const [positions, account] = await Promise.all([client.getPositions(), client.getAccountSummary()]);
    const position = this.positionFor(positions, instrument.ticker);
    return { instrument, position, account, ...validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config) };
  }

  private async snapshot(environment: TradingEnvironment): Promise<Snapshot> {
    const client = this.client(environment);
    const [instruments, positions, account] = await Promise.all([this.instruments(environment), client.getPositions(), client.getAccountSummary()]);
    return { instruments, positions, account };
  }

  private async market(environment: TradingEnvironment, instrument: Instrument) {
    try {
      return await this.deps.marketStatus?.(environment, instrument);
    } catch {
      return undefined;
    }
  }

  async usageToday(environment: TradingEnvironment): Promise<DailyUsage> {
    return (await this.deps.store.get<DailyUsage>(usageKey(environment))) ?? EMPTY_USAGE;
  }

  private async recordUsage(environment: TradingEnvironment, estimatedNotional: number | undefined, sameCurrency: boolean) {
    try {
      const key = usageKey(environment);
      const next = addUsage((await this.deps.store.get<DailyUsage>(key)) ?? EMPTY_USAGE, estimatedNotional, sameCurrency);
      await this.deps.store.put(key, next, Date.now() + USAGE_TTL_MS);
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot usage persistence failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private orderNotices(draft: OrderDraft, current: { estimatedNotional?: number; cashCheckApplied: boolean; estimatedNotionalCurrency: string; accountCurrency?: string }, market?: MarketStatus): OrderNotice[] {
    const notices: OrderNotice[] = [];
    if (draft.environment === "live") notices.push({ code: "LIVE_FUNDS", message: "LIVE: confirming this order uses real funds." });
    if (current.estimatedNotional === undefined) {
      notices.push({ code: "NOTIONAL_ESTIMATE_UNAVAILABLE", message: "The order amount cannot be estimated before submission." });
    } else if (!current.cashCheckApplied && draft.side === "buy") {
      notices.push({
        code: "CROSS_CURRENCY_FUNDS_CHECK",
        message: "The account and instrument use different currencies, so Trading 212 remains the final funds check.",
        details: { instrumentCurrency: current.estimatedNotionalCurrency, accountCurrency: current.accountCurrency ?? "" },
      });
      const fxAgeSeconds = dateAgeSeconds(draft.fxRateAt);
      if (fxAgeSeconds !== undefined && fxAgeSeconds > REFERENCE_STALE_SECONDS) notices.push({ code: "FX_RATE_STALE", message: "The FX conversion may be stale.", details: { ageSeconds: fxAgeSeconds, staleAfterSeconds: REFERENCE_STALE_SECONDS } });
    }
    if (draft.type === "market") notices.push({ code: "MARKET_SLIPPAGE", message: "Market orders can execute away from the reference price." });
    if (market && market.session !== "unknown" && !market.isOpen) {
      const queued = draft.type === "market" && !(draft.extendedHours && ["pre_market", "after_hours", "overnight"].includes(market.session));
      notices.push({
        code: queued ? "MARKET_CLOSED_QUEUED" : "MARKET_CLOSED",
        message: queued
          ? "The market is closed. Trading 212 queues this Market order and fills it at the next open, possibly at a gap price."
          : "The regular market session is closed for this instrument.",
        details: { session: market.session, nextOpen: market.nextOpen ?? null },
      });
    }
    if (draft.referencePrice !== undefined) {
      const ageSeconds = dateAgeSeconds(draft.referencePriceAt);
      if (ageSeconds === undefined) notices.push({ code: "REFERENCE_PRICE_TIME_UNKNOWN", message: "The reference price has no timestamp." });
      else if (ageSeconds > REFERENCE_STALE_SECONDS) notices.push({ code: "REFERENCE_PRICE_STALE", message: "The reference price may be stale.", details: { ageSeconds, staleAfterSeconds: REFERENCE_STALE_SECONDS } });
    }
    return notices;
  }

  private policyFor(draft: OrderDraft, instrument: Instrument, position: Position | undefined, account: AccountSummary, estimatedNotional: number | undefined, market: MarketStatus | undefined, usage: DailyUsage): PolicyCheck[] {
    return evaluatePolicy(this.deps.config.policy[draft.environment], {
      draft, instrument, account, usage,
      ...(position ? { position } : {}),
      ...(estimatedNotional === undefined ? {} : { estimatedNotional }),
      ...(market ? { market } : {}),
    });
  }

  private assertPolicy(checks: PolicyCheck[], ticker: string) {
    const blocked = blockingChecks(checks);
    if (blocked.length) fail("POLICY_BLOCKED", `${ticker}: ${blocked.map((check) => check.message).join(" ")}`, { rule: blocked[0]!.rule });
  }

  private async issue(value: Pending) {
    const token = randomToken();
    const expiresAt = Date.now() + this.deps.config.confirmationTtlSeconds * 1000;
    await this.deps.store.put(`confirm:${token}`, value, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  private async createVerificationRecord(record: VerificationRecord): Promise<string | undefined> {
    const verificationId = randomToken(20);
    try {
      await this.deps.store.put(`verify:${verificationId}`, record, Date.now() + VERIFICATION_TTL_MS);
      return verificationId;
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot verification persistence failed", error: error instanceof Error ? error.message : String(error) }));
      return undefined;
    }
  }

  async prepareOrder(raw: OrderDraft): Promise<OrderPreview> {
    const draft = { ...raw, ticker: raw.ticker.trim() };
    const current = await this.current(draft);
    const snapshotAt = new Date().toISOString();
    const market = await this.market(draft.environment, current.instrument);
    const policy = this.policyFor(draft, current.instrument, current.position, current.account, current.estimatedNotional, market, await this.usageToday(draft.environment));
    this.assertPolicy(policy, draft.ticker);
    const notices = this.orderNotices(draft, current, market);
    const confirmation = await this.issue({ kind: "order", draft });
    await this.recordActivity("order_prepared", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity });
    return {
      kind: "order_preview",
      ...confirmation,
      snapshotAt,
      draft,
      instrument: current.instrument,
      ...(current.estimatedNotional === undefined ? {} : { estimatedNotional: current.estimatedNotional }),
      estimatedNotionalCurrency: current.estimatedNotionalCurrency,
      ...(current.accountCurrency ? { accountCurrency: current.accountCurrency } : {}),
      ...(current.availableCash === undefined ? {} : { availableCash: current.availableCash }),
      ...(current.position ? { availableToSell: current.position.quantityAvailableForTrading } : {}),
      notices,
      policy,
      warnings: notices.map((notice) => notice.message),
    };
  }

  /**
   * Consume a confirmation token. A Live order or basket also needs the second, explicit
   * acknowledgement from the UI; without it the token is left untouched so the user can still confirm.
   */
  private async takePending<K extends "order" | "basket">(confirmationId: string, kind: K, liveAcknowledged: boolean): Promise<Extract<Pending, { kind: K }>> {
    const key = `confirm:${confirmationId}`;
    const peeked = await this.deps.store.get<Pending>(key);
    if (!peeked || peeked.kind !== kind) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    const environment = peeked.kind === "order" ? peeked.draft.environment : peeked.environment;
    if (environment === "live" && !liveAcknowledged) fail("LIVE_ACK_REQUIRED", "Live orders need the second confirmation that real money will be used");
    const pending = await this.deps.store.consume<Pending>(key);
    if (!pending || pending.kind !== kind) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    return pending as Extract<Pending, { kind: K }>;
  }

  async executeOrder(confirmationId: string, options: { liveAcknowledged?: boolean } = {}): Promise<OrderExecutionResult> {
    const pending = await this.takePending(confirmationId, "order", !!options.liveAcknowledged);
    const draft = pending.draft;
    let current: Awaited<ReturnType<TradingService["current"]>>;
    try {
      current = await this.current(draft);
      // Re-check the policy: the market may have closed or the daily budget filled since review.
      const market = await this.market(draft.environment, current.instrument);
      this.assertPolicy(this.policyFor(draft, current.instrument, current.position, current.account, current.estimatedNotional, market, await this.usageToday(draft.environment)), draft.ticker);
    } catch (error) {
      return this.failedSubmission(draft, 0, error);
    }
    return this.submit(draft, current.position?.quantity ?? 0, current.estimatedNotional, sameCurrency(current.account, current.instrument));
  }

  /** Compute (but never send) the trades that move the account toward target weights. */
  async planRebalance(environment: TradingEnvironment, targets: RebalanceTarget[], options: RebalanceOptions = {}): Promise<RebalancePlan> {
    if (!credentialStatus(this.deps.config)[environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${environment.toUpperCase()} credentials are not configured`);
    const snapshot = await this.snapshot(environment);
    const resolved = targets.map((target) => ({ ...target, ticker: resolveInstrumentFromList(snapshot.instruments, target.ticker).ticker }));
    const currency = new Map(snapshot.instruments.map((item) => [item.ticker.toUpperCase(), item.currencyCode]));
    return planRebalance(environment, snapshot.account, snapshot.positions, resolved, options, (ticker) => currency.get(ticker.toUpperCase()));
  }

  rebalanceBasket(plan: RebalancePlan): Omit<BasketDraftPayload, "credentials" | "writeEnabled"> {
    const at = new Date().toISOString();
    return {
      kind: "basket_draft",
      environment: plan.environment,
      purpose: "rebalance",
      title: "Rebalance",
      legs: plan.trades.map((trade) => ({
        draft: { environment: plan.environment, ticker: trade.ticker, side: trade.side, type: "market", quantity: trade.quantity, referencePrice: trade.price, referencePriceAt: at },
        reason: `${(trade.currentWeight * 100).toFixed(1)}% → ${(trade.resultingWeight * 100).toFixed(1)}% (target ${(trade.targetWeight * 100).toFixed(1)}%)`,
      })),
      notes: [...plan.notes, ...plan.skipped.map((item) => `${item.ticker}: ${item.reason}`)],
    };
  }

  /**
   * Draft broker-native protective orders for a holding: a Stop sell below the price and/or a
   * Limit sell above it, both Good-Till-Cancel. Trading 212 triggers them; nothing runs here.
   */
  async protectiveBasket(environment: TradingEnvironment, instrumentQuery: string, input: { stopLossPrice?: number; takeProfitPrice?: number; quantity?: number }): Promise<Omit<BasketDraftPayload, "credentials" | "writeEnabled">> {
    if (input.stopLossPrice === undefined && input.takeProfitPrice === undefined) fail("INVALID_INPUT", "Give a stopLossPrice, a takeProfitPrice, or both");
    if (!credentialStatus(this.deps.config)[environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${environment.toUpperCase()} credentials are not configured`);
    const snapshot = await this.snapshot(environment);
    const instrument = resolveInstrumentFromList(snapshot.instruments, instrumentQuery);
    const position = this.positionFor(snapshot.positions, instrument.ticker);
    if (!position || position.quantityAvailableForTrading <= 0) fail("NO_AVAILABLE_POSITION", `There is no tradable ${instrument.ticker} position to protect`);
    const quantity = input.quantity ?? position.quantityAvailableForTrading;
    if (quantity <= 0 || quantity > position.quantityAvailableForTrading + Number.EPSILON) fail("INSUFFICIENT_SELLABLE_QUANTITY", `quantity must be between 0 and ${position.quantityAvailableForTrading}`);
    const price = position.currentPrice;
    if (input.stopLossPrice !== undefined && price && input.stopLossPrice >= price) fail("INVALID_INPUT", `The stop-loss price must be below the current price ${price}`, { field: "stopLossPrice" });
    if (input.takeProfitPrice !== undefined && price && input.takeProfitPrice <= price) fail("INVALID_INPUT", `The take-profit price must be above the current price ${price}`, { field: "takeProfitPrice" });

    const legs: BasketDraftPayload["legs"] = [];
    if (input.stopLossPrice !== undefined) legs.push({ draft: { environment, ticker: instrument.ticker, side: "sell", type: "stop", quantity, stopPrice: input.stopLossPrice, timeValidity: "GOOD_TILL_CANCEL" }, reason: `Stop-loss at ${input.stopLossPrice} ${instrument.currencyCode}` });
    if (input.takeProfitPrice !== undefined) legs.push({ draft: { environment, ticker: instrument.ticker, side: "sell", type: "limit", quantity, limitPrice: input.takeProfitPrice, timeValidity: "GOOD_TILL_CANCEL" }, reason: `Take-profit at ${input.takeProfitPrice} ${instrument.currencyCode}` });
    return {
      kind: "basket_draft",
      environment,
      purpose: "protective",
      title: `Protect ${instrument.shortName || instrument.ticker}`,
      legs,
      notes: [
        "Both orders stay at Trading 212 until they fill or you cancel them.",
        ...(legs.length === 2
          ? [this.deps.config.protectiveLinking
            ? "TradePilot links the two orders: about a minute after one fills, it cancels the other. Trading 212 may reject the second if the first already reserves the shares; then only the first is placed."
            : "They are not linked: when one fills, cancel the other. Trading 212 may reject the second if the first already reserves the shares."]
          : []),
        "A Stop order becomes a Market order when triggered, so a gap can fill it below the stop price.",
      ],
    };
  }

  /**
   * Validate every leg of a basket against one account snapshot. Sells run before buys, and
   * unless `independentSells` is set, later legs see the shares and cash earlier legs use.
   */
  private assessBasket(request: Pick<BasketRequest, "environment" | "drafts" | "independentSells">, snapshot: Snapshot, usageBefore: DailyUsage, markets: Map<string, MarketStatus | undefined>) {
    const ordered = [...request.drafts].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
    const sold = new Map<string, number>();
    let cashDelta = 0;
    let usage = usageBefore;
    return ordered.map((raw, index) => {
      if (raw.environment !== request.environment) fail("INVALID_INPUT", "Every basket leg must use the basket's environment");
      try {
        const instrument = resolveInstrumentFromList(snapshot.instruments, raw.ticker);
        const draft: OrderDraft = { ...raw, ticker: instrument.ticker };
        const held = this.positionFor(snapshot.positions, instrument.ticker);
        const alreadySold = request.independentSells ? 0 : sold.get(instrument.ticker) ?? 0;
        const position = held ? { ...held, quantityAvailableForTrading: held.quantityAvailableForTrading - alreadySold } : undefined;
        const cash = snapshot.account.cash?.availableToTrade;
        const account: AccountSummary = cash === undefined ? snapshot.account : { ...snapshot.account, cash: { ...snapshot.account.cash, availableToTrade: cash + cashDelta } };
        const checked = validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config);
        const market = markets.get(instrument.ticker);
        const policy = this.policyFor(draft, instrument, held, snapshot.account, checked.estimatedNotional, market, usage);
        const same = sameCurrency(snapshot.account, instrument);
        if (draft.side === "sell") sold.set(instrument.ticker, alreadySold + draft.quantity);
        if (same && checked.estimatedNotional !== undefined) cashDelta += draft.side === "sell" ? checked.estimatedNotional : -checked.estimatedNotional;
        usage = addUsage(usage, checked.estimatedNotional, same);
        return { draft, instrument, position: held, checked, market, policy, same };
      } catch (error) {
        const structured = asStructuredError(error);
        fail(structured.code, `Leg ${index + 1} (${raw.side} ${raw.quantity} ${raw.ticker}): ${structured.message}`, structured.details);
      }
    });
  }

  private async marketsFor(environment: TradingEnvironment, snapshot: Snapshot, drafts: OrderDraft[]) {
    const markets = new Map<string, MarketStatus | undefined>();
    for (const draft of drafts) {
      try {
        const instrument = resolveInstrumentFromList(snapshot.instruments, draft.ticker);
        if (!markets.has(instrument.ticker)) markets.set(instrument.ticker, await this.market(environment, instrument));
      } catch { /* reported by assessBasket */ }
    }
    return markets;
  }

  async prepareBasket(request: BasketRequest): Promise<BasketPreview> {
    if (!credentialStatus(this.deps.config)[request.environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${request.environment.toUpperCase()} credentials are not configured`);
    if (!request.drafts.length || request.drafts.length > MAX_BASKET_LEGS) fail("INVALID_INPUT", `A basket needs 1 to ${MAX_BASKET_LEGS} orders`);
    const snapshot = await this.snapshot(request.environment);
    const snapshotAt = new Date().toISOString();
    const markets = await this.marketsFor(request.environment, snapshot, request.drafts);
    const legs = this.assessBasket(request, snapshot, await this.usageToday(request.environment), markets);
    const blocked = legs.flatMap((leg) => blockingChecks(leg.policy).map((check) => `${leg.instrument.ticker}: ${check.message}`));
    if (blocked.length) fail("POLICY_BLOCKED", blocked.join(" "), { rule: blockingChecks(legs.flatMap((leg) => leg.policy))[0]!.rule });

    const drafts = legs.map((leg) => leg.draft);
    const confirmation = await this.issue({
      kind: "basket",
      environment: request.environment,
      purpose: request.purpose,
      title: request.title,
      drafts,
      independentSells: !!request.independentSells,
      ...(request.planId ? { planId: request.planId } : {}),
    });
    await this.recordActivity("basket_prepared", request.environment, { legs: drafts.length, ...(request.planId ? { planId: request.planId } : {}) });
    return {
      kind: "basket_preview",
      ...confirmation,
      snapshotAt,
      environment: request.environment,
      purpose: request.purpose,
      title: request.title,
      legs: legs.map((leg) => ({
        draft: leg.draft,
        instrument: leg.instrument,
        ...(leg.checked.estimatedNotional === undefined ? {} : { estimatedNotional: leg.checked.estimatedNotional }),
        estimatedNotionalCurrency: leg.checked.estimatedNotionalCurrency,
        notices: this.orderNotices(leg.draft, leg.checked, leg.market),
        policy: leg.policy,
      })),
      notes: [
        ...(request.notes ?? []),
        "Orders are sent one at a time, sells first. If a result is uncertain, the remaining orders are not sent.",
      ],
      ...(request.planId ? { planId: request.planId } : {}),
    };
  }

  private async submit(draft: OrderDraft, baselineQuantity: number, estimatedNotional: number | undefined, same: boolean): Promise<OrderExecutionResult> {
    try {
      const order = await this.client(draft.environment).placeOrder(draft);
      await this.recordUsage(draft.environment, estimatedNotional, same);
      await this.recordActivity("order_submitted", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity });
      return { kind: "order_execution", environment: draft.environment, ok: true, status: "submitted", order, message: `${draft.environment.toUpperCase()} order submitted to Trading 212` };
    } catch (error) {
      return this.failedSubmission(draft, baselineQuantity, error);
    }
  }

  private async failedSubmission(draft: OrderDraft, baselineQuantity: number, error: unknown): Promise<OrderExecutionResult> {
    if (error instanceof ExecutionStatusUnknownError) {
      const verificationId = await this.createVerificationRecord({ kind: "order", environment: draft.environment, draft, baselineQuantity, createdAt: new Date().toISOString() });
      await this.recordActivity("order_status_unknown", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity, outcome: "unknown" });
      return { kind: "order_execution", environment: draft.environment, ok: false, status: "unknown", ...(verificationId ? { verificationId } : {}), error: asStructuredError(error), message: error.message };
    }
    await this.recordActivity("order_rejected", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity });
    return { kind: "order_execution", environment: draft.environment, ok: false, status: "rejected", error: asStructuredError(error), message: error instanceof Error ? error.message : String(error) };
  }

  /** Send a confirmed basket. Writes are never retried; an uncertain result stops the rest. */
  async executeBasket(confirmationId: string, options: { liveAcknowledged?: boolean } = {}): Promise<BasketExecutionResult> {
    const pending = await this.takePending(confirmationId, "basket", !!options.liveAcknowledged);
    const results: BasketExecutionResult["legs"] = [];
    let stopReason: string | undefined;

    let assessed: ReturnType<TradingService["assessBasket"]> | undefined;
    try {
      const snapshot = await this.snapshot(pending.environment);
      const markets = await this.marketsFor(pending.environment, snapshot, pending.drafts);
      assessed = this.assessBasket(pending, snapshot, await this.usageToday(pending.environment), markets);
    } catch (error) {
      stopReason = `The basket no longer passes its checks: ${asStructuredError(error).message}`;
    }

    if (assessed) {
      for (const leg of assessed) {
        if (stopReason) { results.push({ draft: leg.draft, skipped: stopReason }); continue; }
        const blocked = blockingChecks(leg.policy);
        if (blocked.length) { results.push({ draft: leg.draft, skipped: blocked.map((check) => check.message).join(" ") }); continue; }
        const result = await this.submit(leg.draft, leg.position?.quantity ?? 0, leg.checked.estimatedNotional, leg.same);
        results.push({ draft: leg.draft, result });
        if (result.status === "unknown") stopReason = "Not sent: an earlier order's result is uncertain. Verify it before sending the rest.";
      }
    } else {
      for (const draft of pending.drafts) results.push({ draft, skipped: stopReason ?? "Not sent." });
    }

    const submitted = results.filter((leg) => leg.result?.ok).length;
    const status: BasketExecutionResult["status"] = submitted === results.length
      ? "submitted"
      : submitted > 0 ? "partial" : results.some((leg) => leg.result?.status === "unknown") || !assessed ? "stopped" : "rejected";
    const outcome: BasketExecutionResult = {
      kind: "basket_execution",
      environment: pending.environment,
      purpose: pending.purpose,
      ok: status === "submitted",
      status,
      legs: results,
      message: `${submitted} of ${results.length} order(s) submitted to Trading 212 ${pending.environment.toUpperCase()}.${stopReason ? ` ${stopReason}` : ""}`,
    };
    await this.recordActivity("basket_submitted", pending.environment, { legs: results.length, outcome: status, ...(pending.planId ? { planId: pending.planId } : {}) });
    if (pending.purpose === "protective") await this.linkProtectiveOrders(pending.environment, results);
    if (pending.planId && this.deps.afterBasket) {
      try {
        await this.deps.afterBasket(pending.planId, outcome);
      } catch (error) {
        console.error(JSON.stringify({ message: "TradePilot plan update failed", error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return outcome;
  }

  /**
   * Trading 212 has no one-cancels-other order. When both a stop-loss and a take-profit were
   * accepted, remember the pair so the scheduler can cancel the survivor once the other fills.
   */
  private async linkProtectiveOrders(environment: TradingEnvironment, legs: BasketExecutionResult["legs"]) {
    if (!this.deps.config.protectiveLinking) return;
    const orders = legs.flatMap((leg) => {
      const id = orderIdOf(leg.result?.order);
      if (!leg.result?.ok || !id) return [];
      return [{ orderId: id, role: leg.draft.type === "stop" || leg.draft.type === "stop_limit" ? "stop_loss" as const : "take_profit" as const }];
    });
    if (orders.length !== 2 || orders[0]!.role === orders[1]!.role) return;
    const link: ProtectiveLink = { id: randomToken(12), environment, ticker: legs[0]!.draft.ticker, orders: [orders[0]!, orders[1]!], createdAt: new Date().toISOString() };
    try {
      await this.deps.store.put(`link:${link.id}`, link, Date.now() + LINK_TTL_MS);
      await this.recordActivity("protective_linked", environment, { ticker: link.ticker, orderId: `${orders[0]!.orderId},${orders[1]!.orderId}` });
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot protective link persistence failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Ids of the orders currently pending at the broker. */
  async pendingOrderIds(environment: TradingEnvironment): Promise<Set<string>> {
    const orders = await this.client(environment).getOrders();
    return new Set(orders.map((order) => order.id).filter((id) => id !== undefined && id !== null).map(String));
  }

  /** Final state of recent orders from the newest history pages, keyed by order id. */
  async recentOrderOutcomes(environment: TradingEnvironment, pages = 2): Promise<Map<string, { status: string; filledQuantity: number }>> {
    const client = this.client(environment);
    const outcomes = new Map<string, { status: string; filledQuantity: number }>();
    let path: string | undefined;
    for (let page = 0; page < pages; page++) {
      const result = await client.getHistoryPage("orders", path);
      for (const item of result.items) {
        const id = item.order?.id;
        if (id === undefined || id === null) continue;
        const filled = Math.max(item.order?.filledQuantity ?? 0, item.fill?.quantity ?? 0);
        const previous = outcomes.get(String(id));
        outcomes.set(String(id), { status: (item.order?.status ?? previous?.status ?? "").toUpperCase(), filledQuantity: Math.max(filled, previous?.filledQuantity ?? 0) });
      }
      if (!result.nextPagePath) break;
      path = result.nextPagePath;
    }
    return outcomes;
  }

  /** Cancel the surviving order of a protective pair. Sent once; an unclear result is reported, not retried. */
  async cancelLinkedOrder(environment: TradingEnvironment, orderId: string, reason: string): Promise<"cancelled" | "unknown" | "rejected"> {
    try {
      await this.client(environment).cancelOrder(orderId);
      await this.recordActivity("protective_sibling_cancelled", environment, { orderId, outcome: reason.slice(0, 200) });
      return "cancelled";
    } catch (error) {
      const unknown = error instanceof ExecutionStatusUnknownError;
      await this.recordActivity(unknown ? "cancel_status_unknown" : "cancel_rejected", environment, { orderId, outcome: reason.slice(0, 200) });
      return unknown ? "unknown" : "rejected";
    }
  }

  async prepareCancel(environment: TradingEnvironment, orderId: string): Promise<CancelPreview> {
    const id = orderId.trim();
    if (!id) fail("INVALID_INPUT", "orderId is required", { field: "orderId" });
    await this.client(environment).getOrder(id);
    const preview = { kind: "cancel_preview" as const, ...(await this.issue({ kind: "cancel", environment, orderId: id })), environment, orderId: id };
    await this.recordActivity("cancel_prepared", environment, { orderId: id });
    return preview;
  }

  async executeCancel(confirmationId: string): Promise<OrderExecutionResult> {
    const pending = await this.deps.store.consume<Pending>(`confirm:${confirmationId}`);
    if (!pending || pending.kind !== "cancel") fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    try {
      const order = await this.client(pending.environment).cancelOrder(pending.orderId);
      await this.recordActivity("cancel_submitted", pending.environment, { orderId: pending.orderId });
      return { kind: "order_execution", environment: pending.environment, ok: true, status: "submitted", order, message: `${pending.environment.toUpperCase()} cancellation submitted` };
    } catch (error) {
      if (error instanceof ExecutionStatusUnknownError) {
        const verificationId = await this.createVerificationRecord({ kind: "cancel", environment: pending.environment, orderId: pending.orderId, createdAt: new Date().toISOString() });
        await this.recordActivity("cancel_status_unknown", pending.environment, { orderId: pending.orderId, outcome: "unknown" });
        return { kind: "order_execution", environment: pending.environment, ok: false, status: "unknown", ...(verificationId ? { verificationId } : {}), error: asStructuredError(error), message: error.message };
      }
      await this.recordActivity("cancel_rejected", pending.environment, { orderId: pending.orderId });
      return { kind: "order_execution", environment: pending.environment, ok: false, status: "rejected", error: asStructuredError(error), message: error instanceof Error ? error.message : String(error) };
    }
  }

  async verifyExecution(verificationId: string): Promise<ExecutionVerificationResult> {
    const record = await this.deps.store.get<VerificationRecord>(`verify:${verificationId}`);
    if (!record) fail("VERIFICATION_NOT_FOUND", "Verification record is missing or expired", { verificationId });
    const checkedAt = new Date().toISOString();
    const client = this.client(record.environment);
    let result: ExecutionVerificationResult;

    if (record.kind === "order") {
      const [orders, positions] = await Promise.all([client.getOrders(), client.getPositions()]);
      const recordTime = Date.parse(record.createdAt);
      const pendingMatch = orders.find((order) => {
        if ((order.ticker ?? "").toUpperCase() !== record.draft.ticker.toUpperCase()) return false;
        const quantity = orderQuantity(order);
        if (quantity === undefined || !closeQuantity(quantity, record.draft.quantity)) return false;
        if (order.type && String(order.type).replaceAll("-", "_").toUpperCase() !== record.draft.type.toUpperCase()) return false;
        if (order.createdAt && Number.isFinite(recordTime)) {
          const orderTime = Date.parse(order.createdAt);
          if (Number.isFinite(orderTime) && orderTime < recordTime - 60_000) return false;
        }
        return true;
      });
      const currentQuantity = this.positionFor(positions, record.draft.ticker)?.quantity ?? 0;
      const positionDelta = currentQuantity - record.baselineQuantity;
      const expectedMovement = record.draft.side === "buy" ? positionDelta : -positionDelta;
      if (pendingMatch) {
        result = { kind: "execution_verification", verificationId, environment: record.environment, operation: "order", status: "confirmed_pending", checkedAt, ticker: record.draft.ticker, positionDelta, message: "A matching pending order is visible in Trading 212. Do not resubmit it." };
      } else if (record.draft.type === "market" && expectedMovement >= record.draft.quantity - Math.max(1e-8, record.draft.quantity * 1e-6)) {
        result = { kind: "execution_verification", verificationId, environment: record.environment, operation: "order", status: "likely_executed", checkedAt, ticker: record.draft.ticker, positionDelta, message: "The position moved in the expected direction by the requested size. The market order was likely executed; verify broker activity before any retry." };
      } else {
        result = { kind: "execution_verification", verificationId, environment: record.environment, operation: "order", status: "no_evidence", checkedAt, ticker: record.draft.ticker, positionDelta, message: "No matching pending order or conclusive position change is visible yet. Do not retry automatically; verify Trading 212 activity first." };
      }
    } else {
      try {
        await client.getOrder(record.orderId);
        result = { kind: "execution_verification", verificationId, environment: record.environment, operation: "cancel", status: "still_pending", checkedAt, orderId: record.orderId, message: "The order is still visible. Refresh Trading 212 before deciding whether to retry the cancellation." };
      } catch (error) {
        if (error instanceof Trading212ApiError && error.status === 404) {
          result = { kind: "execution_verification", verificationId, environment: record.environment, operation: "cancel", status: "no_longer_pending", checkedAt, orderId: record.orderId, message: "The order is no longer visible as pending. The cancellation may have completed or the order may have filled; check broker activity for the final outcome." };
        } else throw error;
      }
    }

    await this.recordActivity("order_verification", record.environment, { ...(record.kind === "order" ? { ticker: record.draft.ticker } : { orderId: record.orderId }), outcome: result.status });
    return result;
  }

}
