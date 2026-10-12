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
  RiskSizing,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts.js";
import type { BasketDraftPayload, BasketExecutionResult, BasketPreview, BasketPurpose, PolicyCheck, ProtectiveLink, RebalancePlan, RebalanceTarget } from "../shared/automation.js";
import { BASKET_ORDER_NOTE } from "../shared/automation.js";
import { stopProtection, STOPS_BASKET_TITLE, suggestedStop, SUGGESTED_STOP_DROP } from "../shared/protection.js";
import type { MarketStatus } from "../shared/history.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import { crossRate, knownFxRates, toAccountCurrency, type FxRates } from "./fx.js";
import { planRebalance, type RebalanceOptions } from "./rebalance.js";
import { addUsage, blockingChecks, EMPTY_USAGE, evaluatePolicy, usageKey, type DailyUsage } from "./policy.js";
import type { Notifier } from "./notify.js";
import type { StateStore } from "./state-store.js";
import { ExecutionStatusUnknownError, Trading212ApiError, Trading212Client } from "./trading212-client.js";
import { randomToken } from "./web-utils.js";
import type { ExternalFxRate, ExternalQuote, QuoteOptions, QuoteProvider } from "./quotes.js";

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
/** What the preview of a risk-sized buy showed: the loss over budget it named, or that the price was under the stop-loss. */
type RiskShown = { loss?: number; stopAbove?: true };
type Pending = { kind: "order"; draft: OrderDraft; risk?: RiskShown } | { kind: "cancel"; environment: TradingEnvironment; orderId: string } | PendingBasket;
interface Snapshot { instruments: Instrument[]; positions: Position[]; account: AccountSummary }
/** An order's final state from the broker's history; `quantity` is the order size, 0 when not reported. */
export interface OrderOutcome {
  status: string;
  filledQuantity: number;
  quantity: number;
  ticker?: string;
  /** Average fill price in the instrument's currency, when the history gives fill prices. */
  averagePrice?: number;
  /** Value of the fills in the account currency (`walletImpact.netValue`), when every fill gives one. */
  filledValue?: number;
  filledValueCurrency?: string;
  /** Time of the last fill. */
  filledAt?: string;
}

export interface OrderStatusReport {
  kind: "order_status";
  environment: TradingEnvironment;
  orderId: string;
  /** "closed" is a finished order with no fill and no cancel or reject status. */
  state: "open" | "partly_filled" | "filled" | "cancelled" | "rejected" | "closed" | "not_found";
  order?: PendingOrder;
  fills: Array<{ filledAt?: string; quantity?: number; price?: number; netValue?: number; currency?: string }>;
  timestamp: string;
}
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
  notify?: Notifier;
  /** Optional external quotes for instruments that are not held (Trading 212 has no quote endpoint). */
  quotes?: QuoteProvider;
}

export interface PriceLookup {
  instrument: Instrument;
  price?: number;
  asOf?: string;
  /** "broker" is the held position's last price; otherwise the external provider's name. */
  source?: "broker" | ExternalQuote["source"];
  symbol?: string;
  message?: string;
}

function positiveNumber(name: string, value?: number): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function floorQuantity(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

const ACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCE_STALE_SECONDS = 300;
const USAGE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 400 * 24 * 60 * 60 * 1000;
// Sends for one environment run one at a time, so two confirmations cannot both pass the daily limits.
const SEND_LOCK_TTL_MS = 5 * 60 * 1000;
const SEND_LOCK_WAIT_MS = 45_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/** Notes for a rebalance basket, within the 20 notes of up to 500 characters the review accepts. */
export function basketNotes(plan: Pick<RebalancePlan, "notes" | "skipped">): string[] {
  const clip = (note: string) => (note.length > 500 ? `${note.slice(0, 497)}...` : note);
  const skipped = plan.skipped.map((item) => `${item.ticker}: ${item.reason}`);
  if (plan.notes.length + skipped.length <= 20) return [...plan.notes, ...skipped].map(clip);
  return [...plan.notes.slice(0, 18), `Skipped ${plan.skipped.length} instrument(s) with no usable price or FX rate: ${plan.skipped.map((item) => item.ticker).join(", ")}.`].map(clip);
}

export function resolveInstrumentFromList(instruments: Instrument[], query: string): Instrument {
  const norm = (value: string) => value.trim().toUpperCase();
  const q = norm(query);
  if (!q) throw new Error("Ticker, symbol, or instrument name is required");

  const exact = instruments.find((item) => norm(item.ticker) === q);
  if (exact) return exact;

  // An ISIN names the security; it can be listed on several exchanges in different currencies.
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(q)) {
    const listings = instruments.filter((item) => norm(item.isin ?? "") === q);
    if (listings.length === 1) return listings[0]!;
    if (listings.length > 1) throw new Error(`ISIN ${q} is listed ${listings.length} times. Use an exact Trading 212 ticker: ${listings.slice(0, 8).map((item) => `${item.ticker} (${item.currencyCode})`).join(", ")}`);
  }

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
  /** Instrument-currency units per account-currency unit, from {@link knownFxRates}. */
  rates: FxRates = {},
  /** The quote of the moment for an instrument you do not hold, when one was read: the last price before a caller's. */
  marketPrice?: number,
) {
  if (!draft.ticker.trim()) throw new Error("Ticker is required");
  positiveNumber("quantity", draft.quantity);

  if (config.maxOrderQuantity > 0 && draft.quantity > config.maxOrderQuantity)
    fail("ORDER_QUANTITY_LIMIT", `Quantity exceeds MAX_ORDER_QUANTITY (${config.maxOrderQuantity})`, { requested: draft.quantity, limit: config.maxOrderQuantity });
  if (["limit", "stop_limit"].includes(draft.type)) positiveNumber("limitPrice", draft.limitPrice);
  if (["stop", "stop_limit"].includes(draft.type)) positiveNumber("stopPrice", draft.stopPrice);
  if (draft.extendedHours && draft.type !== "market")
    throw new Error("extendedHours is only supported for Market orders by the Trading 212 Public API");
  if (draft.extendedHours && !instrument.extendedHours)
    throw new Error(`${instrument.ticker} does not support extended-hours execution`);
  if (draft.side === "buy" && instrument.maxOpenQuantity && Math.max(0, position?.quantity ?? 0) + draft.quantity > instrument.maxOpenQuantity + Number.EPSILON)
    throw new Error(`Resulting quantity exceeds Trading 212 maxOpenQuantity (${instrument.maxOpenQuantity})`);
  // A limit or stop ten times away from the last price is almost always a unit slip, such as pounds
  // typed for a fund quoted in pence; it would fill at once or never protect anything.
  const last = position?.currentPrice || marketPrice || draft.referencePrice;
  for (const [name, value] of [["limitPrice", draft.limitPrice], ["stopPrice", draft.stopPrice]] as const) {
    if (!last || !value || draft.type === "market") continue;
    const ratio = value / last;
    if (ratio >= 10 || ratio <= 0.1)
      fail("PRICE_OUT_OF_RANGE", `${name} ${value} is ${ratio >= 10 ? `${round(ratio, 1)} times` : `${round(1 / ratio, 1)} times below`} the last price ${last} ${instrument.currencyCode}. Check the unit (${instrument.currencyCode === "GBX" ? "this instrument is quoted in pence" : "the instrument's quote currency"}).`,
        { field: name, price: value, last, currency: instrument.currencyCode });
  }
  if (draft.side === "sell" && draft.quantity > (position?.quantityAvailableForTrading ?? 0) + Number.EPSILON)
    fail("INSUFFICIENT_SELLABLE_QUANTITY", `Sell quantity ${draft.quantity} exceeds available quantity ${position?.quantityAvailableForTrading ?? 0}`, { requested: draft.quantity, available: position?.quantityAvailableForTrading ?? 0 });

  // A Market order's referencePrice comes from the caller, so it must not be able to talk the
  // notional cap down: when the broker reports a current price, the higher of the two is used.
  // A Stop buy fills at the market once triggered, and at once when the stop is already passed, so it
  // is valued at the higher of its stop and those prices. A Stop sell keeps its stop price, so its
  // proceeds are not overstated when they fund later buys in a basket.
  const marketPrices = [draft.referencePrice, position?.currentPrice].filter((value): value is number => value !== undefined && value > 0);
  const price = draft.type === "limit" || draft.type === "stop_limit"
    ? draft.limitPrice
    : draft.type === "stop"
      ? draft.side === "buy" ? Math.max(draft.stopPrice!, ...marketPrices) : draft.stopPrice
      : marketPrices.length ? Math.max(...marketPrices) : undefined;
  const estimatedNotional = price && price > 0 ? price * draft.quantity : undefined;
  const accountCurrency = (account.currency ?? "").toUpperCase();
  const instrumentCurrency = instrument.currencyCode.toUpperCase();
  const sameCurrency = !!accountCurrency && accountCurrency === instrumentCurrency;
  // The broker's valuation of your holdings wins; a rate the caller supplied fills a currency it lacks.
  if (draft.fxRate !== undefined) positiveNumber("fxRate", draft.fxRate);
  const known = draft.fxRate && accountCurrency && !crossRate(rates, accountCurrency, instrumentCurrency)
    ? { ...rates, [accountCurrency]: 1, [instrumentCurrency]: draft.fxRate }
    : rates;
  // The order's value in the account currency: exact for the same currency, otherwise converted at a
  // known rate (pence and pounds are always convertible).
  const accountNotional = estimatedNotional === undefined
    ? undefined
    : sameCurrency ? estimatedNotional : toAccountCurrency(estimatedNotional, instrumentCurrency, accountCurrency, known);

  if (config.maxOrderNotional > 0) {
    if (!estimatedNotional)
      fail("REFERENCE_PRICE_REQUIRED", "A current referencePrice is required for this Market order while MAX_ORDER_NOTIONAL is enabled. Set MAX_ORDER_NOTIONAL=0 to disable the app-level notional cap.");
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) throw new Error("Estimated order notional is invalid");
    // The cap is in the account currency, so an amount in another currency is never compared as is.
    if (accountNotional === undefined && accountCurrency)
      fail("FX_RATE_REQUIRED", `No ${accountCurrency} to ${instrumentCurrency} exchange rate is known (no holding is priced in ${instrumentCurrency} and the quote source has none), so the order can't be checked against MAX_ORDER_NOTIONAL (${config.maxOrderNotional} ${accountCurrency}). Pass fxRate (${instrumentCurrency} per 1 ${accountCurrency}) with fxRateAt from a dated source, or set MAX_ORDER_NOTIONAL=0.`,
        { from: accountCurrency, to: instrumentCurrency, limit: config.maxOrderNotional });
    const capped = accountNotional ?? estimatedNotional;
    const cappedCurrency = accountCurrency || instrumentCurrency;
    if (capped > config.maxOrderNotional)
      fail("ORDER_NOTIONAL_LIMIT", `Estimated order value ${capped.toFixed(2)} ${cappedCurrency} exceeds MAX_ORDER_NOTIONAL (${config.maxOrderNotional})`, { requested: round(capped, 2), limit: config.maxOrderNotional, currency: cappedCurrency });
  }

  const availableCash = account.cash?.availableToTrade;
  const cashCheckApplied = draft.side !== "buy" || (sameCurrency && estimatedNotional !== undefined);
  if (draft.side === "buy" && sameCurrency && availableCash !== undefined && estimatedNotional !== undefined && estimatedNotional > availableCash)
    fail("INSUFFICIENT_CASH", `Estimated order notional ${estimatedNotional.toFixed(2)} exceeds available cash ${availableCash.toFixed(2)} ${account.currency}`, { requested: round(estimatedNotional, 2), available: round(availableCash, 2), currency: accountCurrency });
  // A converted value is an estimate (Trading 212 also adds its FX fee), so only a clear excess blocks.
  if (draft.side === "buy" && !sameCurrency && availableCash !== undefined && accountNotional !== undefined && accountNotional > availableCash * 1.01)
    fail("INSUFFICIENT_CASH", `Estimated order value about ${accountNotional.toFixed(2)} ${account.currency} exceeds available cash ${availableCash.toFixed(2)} ${account.currency}`, { requested: round(accountNotional, 2), available: round(availableCash, 2), currency: accountCurrency });

  return {
    ...(estimatedNotional === undefined ? {} : { estimatedNotional }),
    ...(accountNotional === undefined ? {} : { accountNotional }),
    estimatedNotionalCurrency: instrument.currencyCode,
    cashCheckApplied,
    ...(availableCash === undefined ? {} : { availableCash }),
    ...(account.currency ? { accountCurrency: account.currency } : {}),
    ...(last ? { lastPrice: last } : {}),
  };
}

/**
 * A risk-sized buy checked again at the prices of the moment: the loss at its stop-loss, valued as the review
 * values the order (the limit, or the highest of the trigger, reference and last price). Over the budget it was
 * sized for, because the price moved or the quantity was changed, it says so before you confirm. So it does
 * when the order's price, or the market price (`marketPrice`, the holding's or the quote's) for an order that can
 * fill now, is at or under the stop-loss: the stop would trigger as soon as the buy fills.
 */
export function riskNotices(draft: OrderDraft, current: { estimatedNotional?: number; accountNotional?: number; estimatedNotionalCurrency: string; accountCurrency?: string; marketPrice?: number }): OrderNotice[] {
  const limit = draft.riskBudget;
  if (!limit || draft.side !== "buy" || !current.estimatedNotional || current.accountNotional === undefined || !(draft.quantity > 0)) return [];
  const price = current.estimatedNotional / draft.quantity;
  const instrumentCurrency = current.estimatedNotionalCurrency;
  const accountCurrency = current.accountCurrency ?? instrumentCurrency;
  // A Stop or Stop Limit buy whose trigger is still above the market cannot fill until the price rises to it.
  const resting = (draft.type === "stop" || draft.type === "stop_limit") && !!draft.stopPrice && !!current.marketPrice && draft.stopPrice > current.marketPrice;
  const lowest = current.marketPrice && current.marketPrice > 0 && !resting ? Math.min(price, current.marketPrice) : price;
  if (!(lowest > limit.stopLossPrice)) {
    return [{ code: "RISK_STOP_ABOVE_PRICE", message: `The price (${round(lowest, 6)} ${instrumentCurrency}) is already at or below the stop-loss of ${limit.stopLossPrice} ${instrumentCurrency} this order was sized for.`, details: { stopLossPrice: limit.stopLossPrice, price: round(lowest, 6), currency: instrumentCurrency } }];
  }
  const loss = current.accountNotional * (price - limit.stopLossPrice) / price;
  // A cent of rounding is not over the budget.
  if (loss <= limit.budget + 0.005) return [];
  return [{
    code: "RISK_OVER_BUDGET",
    message: `At the stop-loss of ${limit.stopLossPrice} ${instrumentCurrency}, this order would now lose about ${loss.toFixed(2)} ${accountCurrency}, more than the ${limit.budget.toFixed(2)} ${accountCurrency} it was sized for: the price has moved or the quantity was changed.`,
    details: { loss: round(loss, 2), budget: limit.budget, stopLossPrice: limit.stopLossPrice, currency: instrumentCurrency, accountCurrency },
  }];
}

/** The risk notices a preview showed, kept with its confirmation so the send can tell what is new. */
function riskShown(notices: OrderNotice[]): { risk?: RiskShown } {
  const over = notices.find((notice) => notice.code === "RISK_OVER_BUDGET");
  const loss = typeof over?.details?.loss === "number" ? over.details.loss : undefined;
  const stopAbove = notices.some((notice) => notice.code === "RISK_STOP_ABOVE_PRICE");
  return loss === undefined && !stopAbove ? {} : { risk: { ...(loss === undefined ? {} : { loss }), ...(stopAbove ? { stopAbove: true as const } : {}) } };
}

/**
 * At the send, a risk-sized buy must lose no more at its stop-loss than the preview said: its budget, or the
 * larger loss the preview named. A price under the stop-loss the preview did not show stops it too. Either
 * way nothing is sent, and a new review shows the order at the new price.
 */
export function assertRiskAsShown(notices: OrderNotice[], shown: RiskShown | undefined) {
  for (const notice of notices) {
    if (notice.code === "RISK_STOP_ABOVE_PRICE" && !shown?.stopAbove)
      fail("RISK_CHANGED", `${notice.message} The price moved after the review; review the order again.`, notice.details ?? {});
    const loss = notice.details?.loss;
    if (notice.code === "RISK_OVER_BUDGET" && typeof loss === "number" && !(shown?.loss !== undefined && loss <= shown.loss + 0.005))
      fail("RISK_CHANGED", `${notice.message} The review showed ${shown?.loss === undefined ? "no loss over the budget" : `a loss of ${shown.loss.toFixed(2)}`}; review the order again.`, notice.details ?? {});
  }
}

/** Warnings for a limit or stop that will not behave the way its price suggests. */
export function priceNotices(draft: OrderDraft, last: number | undefined, currency: string): OrderNotice[] {
  if (!last || draft.type === "market") return [];
  const notices: OrderNotice[] = [];
  const buy = draft.side === "buy";
  const stop = draft.stopPrice;
  if ((draft.type === "stop" || draft.type === "stop_limit") && stop && (buy ? stop <= last : stop >= last))
    notices.push({ code: "STOP_ALREADY_TRIGGERED", message: `The stop ${stop} is already ${buy ? "at or below" : "at or above"} the last price ${last} ${currency}, so the order triggers at once.`, details: { stopPrice: stop, last, currency } });
  const limit = draft.limitPrice;
  if (draft.type === "limit" && limit && (buy ? limit > last * 1.02 : limit < last * 0.98))
    notices.push({ code: "LIMIT_FILLS_AT_ONCE", message: `The limit ${limit} is ${buy ? "above" : "below"} the last price ${last} ${currency}, so the order can fill at once near the market price.`, details: { limitPrice: limit, last, currency } });
  const far = [limit, stop].filter((value): value is number => !!value).map((value) => value / last - 1).find((change) => Math.abs(change) > 0.3);
  if (far !== undefined)
    notices.push({ code: "PRICE_FAR_FROM_LAST", message: `The order price is ${Math.round(Math.abs(far) * 100)}% ${far > 0 ? "above" : "below"} the last price ${last} ${currency}.`, details: { percent: Math.round(far * 100), last, currency } });
  return notices;
}

export class TradingService {
  private readonly cache: InstrumentCache;

  constructor(private readonly deps: TradingServiceDeps) {
    this.cache = deps.instrumentCache ?? new Map();
  }

  private client(environment: TradingEnvironment) {
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
  }

  private readonly currencies = new Map<TradingEnvironment, string>();

  /** The account currency, for labelling amounts. It never changes, so it is fetched once; undefined when unavailable. */
  async accountCurrency(environment: TradingEnvironment): Promise<string | undefined> {
    const known = this.currencies.get(environment);
    if (known) return known;
    if (!credentialStatus(this.deps.config)[environment]) return undefined;
    try {
      const currency = (await this.client(environment).getAccountSummary()).currency;
      if (currency) this.currencies.set(environment, currency);
      return currency;
    } catch {
      return undefined;
    }
  }

  /** The account summary alone: one request, for the scheduler's daily value record. */
  async accountSummary(environment: TradingEnvironment): Promise<AccountSummary> {
    const account = await this.client(environment).getAccountSummary();
    if (account.currency) this.currencies.set(environment, account.currency);
    return account;
  }

  async instruments(environment: TradingEnvironment) {
    const cached = this.cache.get(environment);
    if (cached && cached.expiresAt > Date.now()) return cached.instruments;
    const instruments = await this.client(environment).getInstruments();
    this.cache.set(environment, { instruments, expiresAt: Date.now() + 600_000 });
    return instruments;
  }

  /**
   * Pending orders carry only a ticker. Name them from the holdings or from instrument metadata already
   * cached, without fetching the (rate-limited) instrument list just for the dashboard.
   */
  private namedOrders(environment: TradingEnvironment, orders: PendingOrder[], positions: Position[]): PendingOrder[] {
    const cached = this.cache.get(environment);
    const known = cached && cached.expiresAt > Date.now() ? cached.instruments : [];
    return orders.map((order) => {
      if (order.instrument || typeof order.ticker !== "string") return order;
      const instrument = positions.find((position) => position.instrument.ticker === order.ticker)?.instrument ?? known.find((item) => item.ticker === order.ticker);
      return instrument ? { ...order, instrument: { ticker: instrument.ticker, name: instrument.name, shortName: instrument.shortName, currencyCode: instrument.currencyCode } } : order;
    });
  }

  /** One open order with its instrument name, or undefined when it is no longer pending. */
  async openOrder(environment: TradingEnvironment, orderId: string): Promise<PendingOrder | undefined> {
    const client = this.client(environment);
    const order = (await client.getOrders()).find((item) => String(item.id) === orderId.trim());
    if (!order) return undefined;
    const instrument = (await this.instruments(environment).catch(() => [])).find((item) => item.ticker === order.ticker);
    return this.namedOrders(environment, [order], instrument ? [{ instrument } as Position] : [])[0];
  }

  /** External quote for an instrument that is not held, when a provider is configured and can map it. */
  externalQuote(instrument: Instrument, options?: QuoteOptions): Promise<ExternalQuote | undefined> {
    return this.deps.quotes?.quote(instrument, options) ?? Promise.resolve(undefined);
  }

  /**
   * Rates from the account currency to each of `currencies`: implied by your holdings first, then, for a
   * currency none of them is priced in, the quote provider's. `quoted` holds the ones from the provider.
   */
  async ratesFor(positions: Position[], accountCurrency: string, currencies: Iterable<string>, options?: QuoteOptions): Promise<{ rates: FxRates; quoted: Map<string, ExternalFxRate> }> {
    const account = accountCurrency.toUpperCase();
    const rates = knownFxRates(positions, account);
    const quoted = new Map<string, ExternalFxRate>();
    const provider = this.deps.quotes;
    if (!account || !provider) return { rates, quoted };
    for (const currency of new Set([...currencies].map((item) => item.toUpperCase()))) {
      if (crossRate(rates, account, currency)) continue;
      const rate = await provider.fxRate(account, currency, options);
      if (rate) { rates[currency] = rate.rate; quoted.set(currency, rate); }
    }
    return { rates, quoted };
  }

  /** Best available price: the broker's position price when held, else the external quote. */
  async lookupPrice(environment: TradingEnvironment, query: string): Promise<PriceLookup> {
    const instrument = resolveInstrumentFromList(await this.instruments(environment), query);
    const position = this.positionFor(await this.positions(environment), instrument.ticker);
    if (position?.currentPrice) return { instrument, price: position.currentPrice, asOf: new Date().toISOString(), source: "broker" };
    const quote = await this.externalQuote(instrument);
    if (quote) return { instrument, price: quote.price, asOf: quote.asOf, source: quote.source, symbol: quote.symbol };
    const provider = this.deps.quotes;
    return {
      instrument,
      message: !provider
        ? "Not held, and no quote provider is configured (QUOTE_PROVIDER / QUOTE_API_KEY)."
        : provider.symbolFor(instrument)
          ? `Not held, and ${provider.name} returned no price for ${provider.symbolFor(instrument)}.`
          : `Not held, and ${instrument.ticker} has no ${provider.name} symbol. Add it to QUOTE_SYMBOLS.`,
    };
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
    options: { notify?: boolean } = {},
  ): Promise<ActivityEvent> {
    const timestamp = new Date().toISOString();
    const event: ActivityEvent = { id: crypto.randomUUID(), timestamp, environment, type, ...details };
    try {
      await this.deps.store.put(`activity:${timestamp}:${event.id}`, event, Date.now() + ACTIVITY_TTL_MS);
      // Each environment keeps its own last 100 events, so a busy Demo account cannot push Live out.
      const existing = (await this.deps.store.list<ActivityEvent>("activity:")).filter((item) => item.value.environment === environment);
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
    if (options.notify !== false) await this.deps.notify?.(event);
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
    return { kind: "portfolio", appName: "TradePilot 212", environment, credentials, account, positions, orders: this.namedOrders(environment, orders, positions), activity, timestamp: new Date().toISOString() };
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
    // A rate you pass is used only where your holdings imply none; the quote provider fills the rest.
    if (intent.fxRate !== undefined) positiveNumber("fxRate", intent.fxRate);
    const accountCode = (account.currency ?? "").toUpperCase();
    const instrumentCode = instrument.currencyCode.toUpperCase();
    const { rates, quoted } = await this.ratesFor(positions, accountCode, intent.fxRate ? [] : [instrumentCode]);
    const external = quoted.get(instrumentCode);
    const passedRate = !!intent.fxRate && !!accountCode && !crossRate(rates, accountCode, instrumentCode);
    if (passedRate) rates[instrumentCode] = intent.fxRate!;
    const rateSource = external ? ` (${external.source} rate as of ${external.asOf})` : passedRate ? "" : " (implied by your holdings)";
    let quantity: number;
    let note: string;
    let requestedNotional: number | undefined;
    let requestedNotionalCurrency: string | undefined;
    let estimatedQuoteNotional: number | undefined;
    let risk: RiskSizing | undefined;
    let referencePrice = intent.referencePrice;
    let referencePriceAt = intent.referencePriceAt;
    let fxRateAt = intent.fxRateAt;
    let givenRate = passedRate ? intent.fxRate : undefined;
    // Amount-based sizing of an instrument you do not hold falls back to the external quote provider.
    const needsPrice = (sizing.mode === "notional" || sizing.mode === "cash_percent" || sizing.mode === "risk") && referencePrice === undefined
      && !position?.currentPrice && intent.type === "market";
    // A risk-sized buy of one you do not hold reads it too, given a price or not: a Market or Stop can fill near
    // the quote, and when that is higher the loss at the stop is larger. A Limit keeps it as its reference, in
    // case its type is changed to one of those in the editor.
    const needsRiskQuote = sizing.mode === "risk" && intent.side === "buy" && !position?.currentPrice;
    let quotePrice: number | undefined;
    let quoteAt: string | undefined;
    if (needsPrice || needsRiskQuote) {
      const quote = await this.externalQuote(instrument);
      if (quote) {
        quotePrice = quote.price;
        quoteAt = quote.asOf;
        if (needsPrice) { referencePrice = quote.price; referencePriceAt = quote.asOf; }
      }
    }
    /** The given rate, else the one your holdings imply or the quote provider gives; `from` → instrument currency. */
    const fxRate = (from: string, given: number | undefined) => {
      if (given !== undefined) {
        positiveNumber("fxRateToInstrumentCurrency", given);
        // Carried on the draft so the review can value the order in the account currency.
        if (from.toUpperCase() === (account.currency ?? "").toUpperCase()) givenRate = given;
        return { rate: given, source: "" };
      }
      const rate = crossRate(rates, from, instrument.currencyCode);
      if (!rate) fail("FX_RATE_REQUIRED", `Converting ${from} to ${instrument.currencyCode} needs fxRateToInstrumentCurrency (${instrument.currencyCode} per 1 ${from}); no holding in ${instrument.currencyCode} gives an exchange rate and the quote source has none.`, { from: from.toUpperCase(), to: instrument.currencyCode.toUpperCase() });
      fxRateAt ??= external?.asOf ?? fetchedAt;
      return { rate, source: rateSource };
    };

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
      let converted = "";
      if (accountCurrency !== instrumentCurrency) {
        const { rate, source } = fxRate(accountCurrency, sizing.fxRateToInstrumentCurrency);
        quoteAmount = requestedNotional * rate;
        converted = ` converted at ${round(rate, 6)} ${instrumentCurrency}/${accountCurrency}${source}`;
      }
      quantity = floorQuantity(quoteAmount / pricingReference);
      if (quantity <= 0) throw new Error("The selected cash percentage is too small to produce a positive quantity");
      estimatedQuoteNotional = pricingReference * quantity;
      note = `Use ${sizing.percent}% of available cash (${requestedNotional.toFixed(2)} ${accountCurrency})${converted} to buy approximately ${quantity} share(s).`;
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
    } else if (sizing.mode === "risk") {
      if (intent.side !== "buy") throw new Error("risk sizing is only valid for buy orders; to protect shares you hold, use review_protective_orders");
      positiveNumber("stopLossPrice", sizing.stopLossPrice);
      if ((sizing.amount === undefined) === (sizing.percent === undefined)) throw new Error("risk sizing needs either amount (in the account currency) or percent of the account value, not both");
      // The worst price the buy can fill at, so the loss at the stop is never understated. A Limit or Stop Limit
      // buy fills at its limit or below. A Market buy, or a Stop whose trigger the price has already passed,
      // fills near the last price (the holding's, or the quote source's for one you do not hold), so the highest
      // of that, the price given and a Stop's trigger is taken.
      const current = position?.currentPrice || quotePrice;
      const highest = (...prices: Array<number | undefined>) => {
        const known = prices.filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0);
        return known.length ? Math.max(...known) : undefined;
      };
      const entry = intent.type === "limit" || intent.type === "stop_limit" ? intent.limitPrice
        : intent.type === "stop" ? highest(intent.stopPrice, current, referencePrice)
        : highest(referencePrice, current);
      positiveNumber("referencePrice", entry);
      // The draft's reference is a market price: the higher of the price given and the last price, which for a
      // Market order is its entry. The review values the order and checks the limits at it, also after the type
      // is changed in the editor, rather than at a lower price given. A Stop's trigger is not one: the review
      // already values a Stop buy at its trigger when that is higher, and it compares the trigger with the last
      // price to tell a resting Stop from one that triggers at once. Its time is the holding's or the quote's.
      const reference = intent.type === "market" ? entry : highest(referencePrice, current);
      if (reference !== referencePrice) {
        referencePriceAt = reference === position?.currentPrice ? fetchedAt : reference === quotePrice ? quoteAt : undefined;
        referencePrice = reference;
      }
      if (!(sizing.stopLossPrice < entry)) throw new Error(`The stop-loss (${sizing.stopLossPrice}) must be below the entry price (${entry} ${instrument.currencyCode})`);
      // The budget and the cash are in the account currency; without it, neither can be compared with the fall.
      if (!account.currency) throw new Error("The account currency is unknown, so a risk-sized buy cannot convert its budget or cap it by the cash; pass an amount or a quantity instead");
      const accountCurrency = account.currency.toUpperCase();
      const instrumentCurrency = instrument.currencyCode.toUpperCase();
      let budget: number;
      let budgetText: string;
      if (sizing.percent !== undefined) {
        positiveNumber("percent", sizing.percent);
        if (sizing.percent > 100) throw new Error("percent cannot exceed 100");
        const total = account.totalValue;
        if (!(typeof total === "number" && total > 0)) throw new Error("The account value is unknown, so risk a fixed amount instead of a percentage");
        budget = total * sizing.percent / 100;
        budgetText = `${sizing.percent}% of the account value (${budget.toFixed(2)} ${accountCurrency})`;
      } else {
        positiveNumber("amount", sizing.amount);
        budget = sizing.amount!;
        budgetText = `${budget.toFixed(2)} ${accountCurrency}`;
      }
      if (!(budget >= 0.01)) throw new Error(`The risk budget must be at least 0.01 ${accountCurrency}`);
      let rate = 1;
      let converted = "";
      if (accountCurrency !== instrumentCurrency) {
        const conversion = fxRate(accountCurrency, sizing.fxRateToInstrumentCurrency);
        rate = conversion.rate;
        converted = `, converted at ${round(rate, 6)} ${instrumentCurrency}/${accountCurrency}${conversion.source}`;
      }
      const perShareQuote = entry - sizing.stopLossPrice;
      quantity = floorQuantity(budget * rate / perShareQuote);
      // Never more than the cash can buy: the budget is what the stop may lose, not what the buy may cost.
      const cash = account.cash?.availableToTrade;
      if (typeof cash !== "number" || !Number.isFinite(cash)) throw new Error("The available cash is unknown, so a risk-sized buy cannot be capped; size it by quantity or amount instead");
      const affordable = floorQuantity(Math.max(0, cash) * rate / entry);
      const cashCapped = quantity > affordable;
      if (cashCapped) quantity = affordable;
      if (quantity <= 0) throw new Error(cashCapped ? "There is no available cash to buy with" : "The risk budget is too small for one share's fall to the stop-loss");
      estimatedQuoteNotional = entry * quantity;
      // The budget is a loss, not an amount to spend, so it travels as risk.budget rather than requestedNotional.
      risk = { budget, entryPrice: entry, perShare: perShareQuote / rate, ...(typeof current === "number" && current > 0 ? { currentPrice: current } : {}), ...(cashCapped ? { cashCapped } : {}) };
      const loss = quantity * perShareQuote / rate;
      note = `Risk ${budgetText} with a stop-loss at ${sizing.stopLossPrice} ${instrumentCurrency}: ${round(perShareQuote, 6)} ${instrumentCurrency} a share from ${entry} down to the stop${converted}, so about ${quantity} share(s) costing ${round(estimatedQuoteNotional, 2)} ${instrumentCurrency}.`
        + (cashCapped ? ` That is all the available cash (${cash.toFixed(2)} ${accountCurrency}) buys, so at the stop it would lose about ${loss.toFixed(2)} ${accountCurrency}, less than the budget.` : "")
        + " The stop-loss is not part of this order: set it once the buy fills, and a gap can still fill it lower.";
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
      let conversion: { rate: number; source: string } | undefined;
      if (requestedCurrency !== instrumentCurrency) {
        conversion = fxRate(requestedCurrency, sizing.fxRateToInstrumentCurrency);
        quoteAmount = sizing.amount * conversion.rate;
      }
      quantity = floorQuantity(quoteAmount / pricingReference);
      if (quantity <= 0) throw new Error("The requested amount is too small to produce a positive quantity");
      estimatedQuoteNotional = pricingReference * quantity;
      note = !conversion
        ? `${sizing.amount} ${requestedCurrency} target amount resolves to approximately ${quantity} share(s) at ${pricingReference} ${instrumentCurrency}.`
        : `${sizing.amount} ${requestedCurrency} converted at ${round(conversion.rate, 6)} ${instrumentCurrency}/${requestedCurrency}${conversion.source} resolves to approximately ${quantity} share(s) at ${pricingReference} ${instrumentCurrency}.`;
    }

    // A provider rate travels with the draft, so the confirmation values it the same way.
    if (givenRate === undefined && external) { givenRate = external.rate; fxRateAt ??= external.asOf; }
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
      ...(givenRate === undefined ? {} : { fxRate: givenRate }),
      ...(fxRateAt ? { fxRateAt } : {}),
      // The review checks the loss at the stop again, at the prices of the moment.
      ...(sizing.mode === "risk" && risk ? { riskBudget: { stopLossPrice: sizing.stopLossPrice, budget: round(risk.budget, 2) } } : {}),
    };

    // Validate what can be validated now. This remains read-only; no order is submitted.
    validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config, rates);

    return {
      draft,
      instrument,
      sizing,
      ...(account.currency ? { accountCurrency: account.currency } : {}),
      ...(position ? { heldQuantity: position.quantity, availableToSell: position.quantityAvailableForTrading } : {}),
      ...(requestedNotional === undefined ? {} : { requestedNotional }),
      ...(requestedNotionalCurrency === undefined ? {} : { requestedNotionalCurrency }),
      ...(estimatedQuoteNotional === undefined ? {} : { estimatedQuoteNotional }),
      ...(risk ? { risk } : {}),
      note,
    };
  }

  /** `fresh` (at the send) has a risk-sized buy read its quote and rate from the source itself, not from its cache. */
  private async current(draft: OrderDraft, options: { fresh?: boolean } = {}) {
    const instrument = resolveInstrumentFromList(await this.instruments(draft.environment), draft.ticker);
    draft.ticker = instrument.ticker;
    const client = this.client(draft.environment);
    const [positions, account] = await Promise.all([client.getPositions(), client.getAccountSummary()]);
    const position = this.positionFor(positions, instrument.ticker);
    // A risk-sized buy of an instrument you do not hold reads the quote of the moment. It is the market price: the
    // last price a Stop's trigger and the unit-slip check are compared with, and the price a fall to or under the
    // stop-loss is seen at. A Market or Stop also takes it as its reference when it is above the price it was
    // sized at, so its value and its loss at the stop are not understated, and otherwise dates the reference by
    // it: the reference has just been checked against the market. When the quote source can price the instrument
    // but has no quote just now, the order is refused rather than checked without one (a Limit too: with the
    // market under the stop-loss it would fill there); with no quote source, the price given stands, as for any order.
    const risky = !!draft.riskBudget && draft.side === "buy";
    const lookup = { fresh: risky && !!options.fresh };
    let marketPrice = position?.currentPrice || undefined;
    if (risky && !marketPrice) {
      const quote = await this.externalQuote(instrument, lookup).catch(() => undefined);
      if (quote) {
        marketPrice = quote.price;
        if (draft.type === "market" || draft.type === "stop") {
          if (quote.price > (draft.referencePrice ?? 0)) draft.referencePrice = quote.price;
          draft.referencePriceAt = quote.asOf;
        }
      } else if (this.deps.quotes?.symbolFor(instrument)) {
        fail("RISK_CHECK_UNAVAILABLE", `The quote source has no price for ${instrument.ticker} just now, so the loss at the stop-loss of this risk-sized buy can't be checked. Nothing was sent; try again in a moment.`, { missing: "quote", ticker: instrument.ticker });
      }
    }
    // A risk-sized buy also asks for the exchange rate of the moment instead of the one it was sized at, so an
    // adverse move in the rate counts toward the loss at the stop. When the quote source has exchange rates but
    // none just now, it is refused; with none, or a rate your holdings imply, the review goes on as before.
    const accountCode = (account.currency ?? "").toUpperCase();
    const instrumentCode = instrument.currencyCode.toUpperCase();
    const { rates, quoted } = await this.ratesFor(positions, accountCode, draft.fxRate && !risky ? [] : [instrumentCode], lookup);
    const fresh = risky && draft.fxRate ? quoted.get(instrumentCode) : undefined;
    if (fresh) {
      draft.fxRate = fresh.rate;
      draft.fxRateAt = fresh.asOf;
    } else if (risky && draft.fxRate && accountCode && !crossRate(rates, accountCode, instrumentCode) && this.deps.quotes && this.deps.quotes.hasFxRates !== false) {
      fail("RISK_CHECK_UNAVAILABLE", `The quote source has no ${accountCode} to ${instrumentCode} exchange rate just now, so the loss at the stop-loss of this risk-sized buy can't be checked in ${accountCode}. Nothing was sent; try again in a moment.`, { missing: "fx_rate", from: accountCode, to: instrumentCode });
    }
    const checked = validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config, rates, marketPrice);
    // Its loss at the stop is in the account currency: with no currency or no rate to convert it, it can't be checked.
    if (risky && !accountCode)
      fail("RISK_CHECK_UNAVAILABLE", "The account currency is unknown just now, so the loss at the stop-loss of this risk-sized buy can't be checked against its budget. Nothing was sent.", { missing: "account_currency" });
    if (risky && checked.estimatedNotional !== undefined && checked.accountNotional === undefined)
      fail("RISK_CHECK_UNAVAILABLE", `No ${accountCode} to ${instrumentCode} exchange rate is known just now (no holding is priced in ${instrumentCode} and the quote source has none), so the loss at the stop-loss of this risk-sized buy can't be checked in ${accountCode}. Nothing was sent.`, { missing: "fx_rate", from: accountCode, to: instrumentCode });
    return { instrument, position, account, ...(marketPrice ? { marketPrice } : {}), ...checked };
  }

  private async snapshot(environment: TradingEnvironment): Promise<Snapshot> {
    const client = this.client(environment);
    const [instruments, positions, account] = await Promise.all([this.instruments(environment), client.getPositions(), client.getAccountSummary()]);
    if (account.currency) this.currencies.set(environment, account.currency);
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

  private async recordUsage(environment: TradingEnvironment, accountNotional: number | undefined) {
    try {
      const key = usageKey(environment);
      const next = addUsage((await this.deps.store.get<DailyUsage>(key)) ?? EMPTY_USAGE, accountNotional);
      await this.deps.store.put(key, next, Date.now() + USAGE_TTL_MS);
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot usage persistence failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private orderNotices(draft: OrderDraft, current: { estimatedNotional?: number; accountNotional?: number; cashCheckApplied: boolean; estimatedNotionalCurrency: string; accountCurrency?: string; lastPrice?: number; marketPrice?: number }, market?: MarketStatus): OrderNotice[] {
    const notices: OrderNotice[] = [...priceNotices(draft, current.lastPrice, current.estimatedNotionalCurrency), ...riskNotices(draft, current)];
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
    // A Stop becomes a Market order when it triggers, so a gap through the trigger fills past it.
    if (draft.type === "stop")
      notices.push({
        code: "STOP_SLIPPAGE",
        message: `A Stop order becomes a Market order once triggered, so after a gap it can fill ${draft.side === "buy" ? "above" : "below"} its trigger price${draft.riskBudget && draft.side === "buy" ? "; the loss at the stop-loss is counted from the highest of its trigger, the reference price and the last price, and a fill above that loses more" : ""}.`,
        details: { side: draft.side, riskSized: !!draft.riskBudget && draft.side === "buy" },
      });
    if (draft.type === "market" && this.deps.marketStatus && (!market || market.session === "unknown"))
      notices.push({
        code: "MARKET_HOURS_UNKNOWN",
        message: market
          ? "Trading 212 publishes no trading hours for this instrument, so this Market order may queue until the next open."
          : "The market hours could not be read, so this Market order may queue until the next open.",
        // "unavailable" is a failed read and worth retrying; "no_schedule" will not change.
        details: { reason: market ? "no_schedule" : "unavailable" },
      });
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

  private policyFor(draft: OrderDraft, instrument: Instrument, position: Position | undefined, account: AccountSummary, accountNotional: number | undefined, market: MarketStatus | undefined, usage: DailyUsage, pendingBuyValue?: number): PolicyCheck[] {
    return evaluatePolicy(this.deps.config.policy[draft.environment], {
      draft, instrument, account, usage,
      ...(pendingBuyValue ? { pendingBuyValue } : {}),
      ...(position ? { position } : {}),
      ...(accountNotional === undefined ? {} : { estimatedNotional: accountNotional }),
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
    const policy = this.policyFor(draft, current.instrument, current.position, current.account, current.accountNotional, market, await this.usageToday(draft.environment));
    this.assertPolicy(policy, draft.ticker);
    const notices = this.orderNotices(draft, current, market);
    const confirmation = await this.issue({ kind: "order", draft, ...riskShown(notices) });
    await this.recordActivity("order_prepared", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity });
    return {
      kind: "order_preview",
      ...confirmation,
      snapshotAt,
      draft,
      instrument: current.instrument,
      ...(current.estimatedNotional === undefined ? {} : { estimatedNotional: current.estimatedNotional }),
      estimatedNotionalCurrency: current.estimatedNotionalCurrency,
      ...(current.accountNotional === undefined || current.estimatedNotionalCurrency === current.accountCurrency ? {} : { estimatedAccountNotional: current.accountNotional }),
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
  private async takePending<K extends "order" | "basket" | "cancel">(confirmationId: string, kind: K, liveAcknowledged: boolean): Promise<Extract<Pending, { kind: K }>> {
    const key = `confirm:${confirmationId}`;
    const peeked = await this.deps.store.get<Pending>(key);
    if (!peeked || peeked.kind !== kind) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    const environment = peeked.kind === "order" ? peeked.draft.environment : peeked.environment;
    if (environment === "live" && !liveAcknowledged)
      fail("LIVE_ACK_REQUIRED", kind === "cancel" ? "Live cancellations need the second confirmation: a cancelled stop-loss no longer protects the position" : "Live orders need the second confirmation that real money will be used");
    const pending = await this.deps.store.consume<Pending>(key);
    if (!pending || pending.kind !== kind) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    return pending as Extract<Pending, { kind: K }>;
  }

  /** The environment a confirmation token belongs to, so its send can take that environment's lock. */
  private async pendingEnvironment(confirmationId: string): Promise<TradingEnvironment> {
    const pending = await this.deps.store.get<Pending>(`confirm:${confirmationId}`);
    if (!pending) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    return pending.kind === "order" ? pending.draft.environment : pending.environment;
  }

  /**
   * Run one send at a time per environment. The daily limits are checked and counted inside, so two
   * confirmations sent together cannot both slip under them. A crashed holder's lock expires.
   */
  private async exclusive<T>(environment: TradingEnvironment, run: () => Promise<T>): Promise<T> {
    const key = `send-lock:${environment}`;
    const deadline = Date.now() + SEND_LOCK_WAIT_MS;
    while ((await this.deps.store.increment(key, SEND_LOCK_TTL_MS)).count > 1) {
      if (Date.now() > deadline) fail("EXECUTION_BUSY", `Another ${environment.toUpperCase()} order is still being sent. Try again in a moment; this confirmation is still valid.`);
      await sleep(200);
    }
    try {
      return await run();
    } finally {
      await this.deps.store.delete(key).catch(() => undefined);
    }
  }

  async executeOrder(confirmationId: string, options: { liveAcknowledged?: boolean } = {}): Promise<OrderExecutionResult> {
    return this.exclusive(await this.pendingEnvironment(confirmationId), () => this.sendOrder(confirmationId, options));
  }

  private async sendOrder(confirmationId: string, options: { liveAcknowledged?: boolean }): Promise<OrderExecutionResult> {
    const pending = await this.takePending(confirmationId, "order", !!options.liveAcknowledged);
    const draft = pending.draft;
    let current: Awaited<ReturnType<TradingService["current"]>>;
    try {
      // A risk-sized buy reads the quote and rate of this moment: a cached one can be older than the review.
      current = await this.current(draft, { fresh: true });
      // Re-check the policy: the market may have closed or the daily budget filled since review.
      const market = await this.market(draft.environment, current.instrument);
      this.assertPolicy(this.policyFor(draft, current.instrument, current.position, current.account, current.accountNotional, market, await this.usageToday(draft.environment)), draft.ticker);
      assertRiskAsShown(riskNotices(draft, current), pending.risk);
    } catch (error) {
      return this.failedSubmission(draft, 0, error);
    }
    return this.submit(draft, current.position?.quantity ?? 0, current.accountNotional);
  }

  /** Compute (but never send) the trades that move the account toward target weights. */
  async planRebalance(environment: TradingEnvironment, targets: RebalanceTarget[], options: RebalanceOptions = {}): Promise<RebalancePlan> {
    requireCredentials(this.deps.config, environment);
    const snapshot = await this.snapshot(environment);
    const resolved: RebalanceTarget[] = [];
    for (const target of targets) {
      const instrument = resolveInstrumentFromList(snapshot.instruments, target.ticker);
      // A target you do not hold needs a price; fill it from the quote provider when none was given.
      const held = this.positionFor(snapshot.positions, instrument.ticker)?.currentPrice;
      const quote = !held && target.referencePrice === undefined ? await this.externalQuote(instrument) : undefined;
      resolved.push({ ...target, ticker: instrument.ticker, ...(quote ? { referencePrice: quote.price, referencePriceAt: quote.asOf } : {}) });
    }
    const currency = new Map(snapshot.instruments.map((item) => [item.ticker.toUpperCase(), item.currencyCode]));
    // Currencies no holding prices take the quote provider's rate, unless the caller gave one.
    const missing = resolved.map((target) => currency.get(target.ticker.toUpperCase()) ?? "").filter((code) => code && !options.fxRates?.[code.toUpperCase()]);
    const { quoted } = await this.ratesFor(snapshot.positions, snapshot.account.currency ?? "", missing);
    const quotedFxRates = Object.fromEntries(quoted);
    return planRebalance(environment, snapshot.account, snapshot.positions, resolved, { ...options, ...(quoted.size ? { quotedFxRates } : {}) }, (ticker) => currency.get(ticker.toUpperCase()));
  }

  /** Attach each leg's instrument so a review can show names; legs that do not resolve stay as they are. */
  async withInstruments<T extends { environment: TradingEnvironment; legs: BasketDraftPayload["legs"] }>(basket: T): Promise<T> {
    let instruments: Instrument[];
    try {
      instruments = await this.instruments(basket.environment);
    } catch {
      return basket;
    }
    return {
      ...basket,
      legs: basket.legs.map((leg) => {
        if (leg.instrument) return leg;
        try {
          const instrument = resolveInstrumentFromList(instruments, leg.draft.ticker);
          return { ...leg, instrument, draft: { ...leg.draft, ticker: instrument.ticker } };
        } catch {
          return leg;
        }
      }),
    };
  }

  rebalanceBasket(plan: RebalancePlan): Omit<BasketDraftPayload, "credentials" | "writeEnabled"> {
    return {
      kind: "basket_draft",
      environment: plan.environment,
      purpose: "rebalance",
      title: plan.buyOnly ? "Invest cash by targets" : "Rebalance",
      legs: plan.trades.map((trade) => ({
        // An undated caller price stays undated, so the review flags it and the reference-age rule applies.
        draft: { environment: plan.environment, ticker: trade.ticker, side: trade.side, type: "market", quantity: trade.quantity, referencePrice: trade.price, ...(trade.priceAt ? { referencePriceAt: trade.priceAt } : {}) },
        reason: `${(trade.currentWeight * 100).toFixed(1)}% → ${(trade.resultingWeight * 100).toFixed(1)}% (target ${(trade.targetWeight * 100).toFixed(1)}%)`,
      })),
      notes: basketNotes(plan),
    };
  }

  /**
   * Draft broker-native protective orders for a holding: a Stop sell below the price and/or a
   * Limit sell above it, both Good-Till-Cancel. Trading 212 triggers them; nothing runs here.
   */
  async protectiveBasket(environment: TradingEnvironment, instrumentQuery: string, input: { stopLossPrice?: number; takeProfitPrice?: number; quantity?: number }): Promise<Omit<BasketDraftPayload, "credentials" | "writeEnabled">> {
    if (input.stopLossPrice === undefined && input.takeProfitPrice === undefined) fail("INVALID_INPUT", "Give a stopLossPrice, a takeProfitPrice, or both");
    requireCredentials(this.deps.config, environment);
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
   * One Good-Till-Cancel sell stop for every holding whose free shares no pending sell stop covers yet,
   * largest uncovered value first, as a basket the user confirms once. Each stop matches the holding's
   * existing stop, or starts `dropPercent` below the last price. Trading 212 triggers them; nothing runs here.
   */
  async stopsBasket(environment: TradingEnvironment, input: { dropPercent?: number; tickers?: string[] } = {}): Promise<Omit<BasketDraftPayload, "credentials" | "writeEnabled">> {
    requireCredentials(this.deps.config, environment);
    const drop = (input.dropPercent ?? SUGGESTED_STOP_DROP * 100) / 100;
    const [snapshot, orders] = await Promise.all([this.snapshot(environment), this.client(environment).getOrders()]);
    const only = input.tickers?.length ? new Set(input.tickers.map((query) => resolveInstrumentFromList(snapshot.instruments, query).ticker)) : undefined;
    const accountCurrency = snapshot.account.currency ?? "";
    const rates = knownFxRates(snapshot.positions, accountCurrency);
    // The value at risk in the account currency, so a pence-quoted holding does not jump the queue. Without the
    // broker's valuation, the quote-currency value is converted at a rate other holdings imply; unknown ones go last.
    const exposure = (position: Position, quantity: number) => {
      const wallet = (position.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
      if (typeof wallet === "number" && Number.isFinite(wallet)) return wallet * (quantity / position.quantity);
      return toAccountCurrency(quantity * position.currentPrice, position.instrument.currencyCode, accountCurrency, rates) ?? -1;
    };
    const missing = [...(only ?? [])].filter((ticker) => !snapshot.positions.some((position) => position.instrument.ticker === ticker && position.quantity > 0));
    if (missing.length) fail("NO_AVAILABLE_POSITION", `There is no ${missing.join(", ")} position to protect`);
    const candidates = snapshot.positions.flatMap((position) => {
      if (only && !only.has(position.instrument.ticker)) return [];
      const guard = stopProtection(position, orders);
      const stop = suggestedStop(position, guard, drop);
      return stop ? [{ position, stop, matched: guard !== undefined && stop.stopPrice === guard.stopPrice, exposure: exposure(position, stop.quantity) }] : [];
    }).sort((a, b) => b.exposure - a.exposure);
    if (!candidates.length) {
      // Shares a take-profit or another sell already reserves are not free to sell, so they cannot get a stop either.
      fail("NO_AVAILABLE_POSITION", `${only ? "None of those holdings has" : "No holding has"} shares free to sell that a pending stop-loss does not already cover`);
    }
    const percent = Number((drop * 100).toFixed(2));
    const legs: BasketDraftPayload["legs"] = candidates.slice(0, MAX_BASKET_LEGS).map(({ position, stop, matched }) => ({
      draft: { environment, ticker: position.instrument.ticker, side: "sell", type: "stop", quantity: stop.quantity, stopPrice: stop.stopPrice, timeValidity: "GOOD_TILL_CANCEL" },
      // The widget translates these two reasons (src/ui/lib/messages.ts legReason).
      reason: matched ? "Matches the existing stop" : `${percent}% below the last price`,
    }));
    const left = candidates.length - legs.length;
    return {
      kind: "basket_draft",
      environment,
      purpose: "protective",
      title: STOPS_BASKET_TITLE,
      legs,
      notes: [
        "Each order stays at Trading 212 until it triggers or you cancel it.",
        `A holding that already has a stop gets one at the same price for its uncovered shares; the others start ${percent}% below the last price.`,
        "A Stop order becomes a Market order when triggered, so a gap can fill it below the stop price.",
        ...(left > 0 ? [`${left} more holding(s) without a full stop were left out; a basket holds at most ${MAX_BASKET_LEGS} orders.`] : []),
      ],
    };
  }

  /**
   * Validate every leg of a basket against one account snapshot. Sells run before buys, and
   * unless `independentSells` is set, later legs see the shares and cash earlier legs use.
   */
  private assessBasket(request: Pick<BasketRequest, "environment" | "drafts" | "independentSells">, snapshot: Snapshot, usageBefore: DailyUsage, markets: Map<string, MarketStatus | undefined>, rates: FxRates) {
    const ordered = [...request.drafts].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
    const sold = new Map<string, number>();
    // Buys of one instrument split over several legs are checked together, like sells.
    const bought = new Map<string, { quantity: number; value: number }>();
    let cashDelta = 0;
    let usage = usageBefore;
    return ordered.map((raw, index) => {
      if (raw.environment !== request.environment) fail("INVALID_INPUT", "Every basket leg must use the basket's environment");
      try {
        const instrument = resolveInstrumentFromList(snapshot.instruments, raw.ticker);
        const draft: OrderDraft = { ...raw, ticker: instrument.ticker };
        const held = this.positionFor(snapshot.positions, instrument.ticker);
        const alreadySold = request.independentSells ? 0 : sold.get(instrument.ticker) ?? 0;
        const earlier = bought.get(instrument.ticker);
        const base = held ?? (earlier ? { instrument, quantity: 0, quantityAvailableForTrading: 0, quantityInPies: 0, averagePricePaid: 0, currentPrice: 0 } : undefined);
        const position = base ? { ...base, quantity: base.quantity + (earlier?.quantity ?? 0), quantityAvailableForTrading: base.quantityAvailableForTrading - alreadySold } : undefined;
        const cash = snapshot.account.cash?.availableToTrade;
        const account: AccountSummary = cash === undefined ? snapshot.account : { ...snapshot.account, cash: { ...snapshot.account.cash, availableToTrade: cash + cashDelta } };
        const checked = validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config, rates);
        const market = markets.get(instrument.ticker);
        const policy = this.policyFor(draft, instrument, held, snapshot.account, checked.accountNotional, market, usage, earlier?.value);
        if (draft.side === "sell") sold.set(instrument.ticker, alreadySold + draft.quantity);
        else bought.set(instrument.ticker, { quantity: (earlier?.quantity ?? 0) + draft.quantity, value: (earlier?.value ?? 0) + (checked.accountNotional ?? 0) });
        if (checked.accountNotional !== undefined) cashDelta += draft.side === "sell" ? checked.accountNotional : -checked.accountNotional;
        usage = addUsage(usage, checked.accountNotional);
        return { draft, instrument, position: held, checked, market, policy };
      } catch (error) {
        const structured = asStructuredError(error);
        fail(structured.code, `Leg ${index + 1} (${raw.side} ${raw.quantity} ${raw.ticker}): ${structured.message}`, structured.details);
      }
    });
  }

  /** Rates for every leg's currency, except legs that carry their own. */
  private async basketRates(snapshot: Snapshot, drafts: OrderDraft[]) {
    const currencies = drafts.flatMap((draft) => {
      if (draft.fxRate) return [];
      try { return [resolveInstrumentFromList(snapshot.instruments, draft.ticker).currencyCode]; } catch { return []; }
    });
    return (await this.ratesFor(snapshot.positions, snapshot.account.currency ?? "", currencies)).rates;
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

  /** `quiet` leaves the activity log alone, for the scheduler's retries of a plan that is blocked. */
  async prepareBasket(request: BasketRequest, options: { quiet?: boolean } = {}): Promise<BasketPreview> {
    requireCredentials(this.deps.config, request.environment);
    if (!request.drafts.length || request.drafts.length > MAX_BASKET_LEGS) fail("INVALID_INPUT", `A basket needs 1 to ${MAX_BASKET_LEGS} orders`);
    const snapshot = await this.snapshot(request.environment);
    const snapshotAt = new Date().toISOString();
    const markets = await this.marketsFor(request.environment, snapshot, request.drafts);
    const legs = this.assessBasket(request, snapshot, await this.usageToday(request.environment), markets, await this.basketRates(snapshot, request.drafts));
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
    if (!options.quiet) await this.recordActivity("basket_prepared", request.environment, { legs: drafts.length, ...(request.planId ? { planId: request.planId } : {}) });
    return {
      kind: "basket_preview",
      ...confirmation,
      snapshotAt,
      environment: request.environment,
      purpose: request.purpose,
      title: request.title,
      ...(legs[0]?.checked.accountCurrency ? { accountCurrency: legs[0].checked.accountCurrency } : {}),
      legs: legs.map((leg) => ({
        draft: leg.draft,
        instrument: leg.instrument,
        ...(leg.checked.estimatedNotional === undefined ? {} : { estimatedNotional: leg.checked.estimatedNotional }),
        estimatedNotionalCurrency: leg.checked.estimatedNotionalCurrency,
        ...(leg.checked.accountNotional === undefined || leg.checked.estimatedNotionalCurrency === leg.checked.accountCurrency ? {} : { estimatedAccountNotional: leg.checked.accountNotional }),
        notices: this.orderNotices(leg.draft, leg.checked, leg.market),
        policy: leg.policy,
      })),
      notes: [
        ...(request.notes ?? []),
        BASKET_ORDER_NOTE,
      ],
      ...(request.planId ? { planId: request.planId } : {}),
    };
  }

  /** `accountNotional` is the order's estimated value in the account currency, when known. */
  private async submit(draft: OrderDraft, baselineQuantity: number, accountNotional: number | undefined): Promise<OrderExecutionResult> {
    let order: unknown;
    try {
      order = await this.client(draft.environment).placeOrder(draft);
    } catch (error) {
      // An order that may have gone through still counts toward today's limits.
      if (error instanceof ExecutionStatusUnknownError) await this.recordUsage(draft.environment, accountNotional);
      return this.failedSubmission(draft, baselineQuantity, error);
    }
    // The broker accepted it: nothing after this point may turn that into a failure.
    await this.recordUsage(draft.environment, accountNotional);
    try {
      await this.recordActivity("order_submitted", draft.environment, { ticker: draft.ticker, side: draft.side, orderType: draft.type, quantity: draft.quantity });
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot activity log failed", error: error instanceof Error ? error.message : String(error) }));
    }
    return { kind: "order_execution", environment: draft.environment, ok: true, status: "submitted", order, message: `${draft.environment.toUpperCase()} order submitted to Trading 212` };
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

  /** Send a confirmed basket. An uncertain result stops the rest; only a rate-limited write is sent again. */
  async executeBasket(confirmationId: string, options: { liveAcknowledged?: boolean } = {}): Promise<BasketExecutionResult> {
    return this.exclusive(await this.pendingEnvironment(confirmationId), () => this.sendBasket(confirmationId, options));
  }

  private async sendBasket(confirmationId: string, options: { liveAcknowledged?: boolean }): Promise<BasketExecutionResult> {
    const pending = await this.takePending(confirmationId, "basket", !!options.liveAcknowledged);
    const results: BasketExecutionResult["legs"] = [];
    let stopReason: string | undefined;

    let assessed: ReturnType<TradingService["assessBasket"]> | undefined;
    try {
      const snapshot = await this.snapshot(pending.environment);
      const markets = await this.marketsFor(pending.environment, snapshot, pending.drafts);
      assessed = this.assessBasket(pending, snapshot, await this.usageToday(pending.environment), markets, await this.basketRates(snapshot, pending.drafts));
    } catch (error) {
      stopReason = `The basket no longer passes its checks: ${asStructuredError(error).message}`;
    }

    if (assessed) {
      // Buys were checked against the cash the sells before them free up, so a sell that does not go
      // through stops them: otherwise they could spend the cash reserve.
      let unfunded: string | undefined;
      for (const leg of assessed) {
        if (stopReason) { results.push({ draft: leg.draft, skipped: stopReason }); continue; }
        if (unfunded && leg.draft.side === "buy") { results.push({ draft: leg.draft, skipped: unfunded }); continue; }
        const blocked = blockingChecks(leg.policy);
        const fundsBuys = leg.draft.side === "sell" && !pending.independentSells;
        if (blocked.length) {
          results.push({ draft: leg.draft, skipped: blocked.map((check) => check.message).join(" ") });
          if (fundsBuys) unfunded = `Not sent: the sell of ${leg.draft.ticker} that funds it was not sent.`;
          continue;
        }
        const result = await this.submit(leg.draft, leg.position?.quantity ?? 0, leg.checked.accountNotional);
        results.push({ draft: leg.draft, result });
        if (result.status === "unknown") stopReason = "Not sent: an earlier order's result is uncertain. Verify it before sending the rest.";
        else if (!result.ok && fundsBuys) unfunded = `Not sent: the sell of ${leg.draft.ticker} that funds it was rejected.`;
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

  /** The orders currently pending at the broker. */
  pendingOrders(environment: TradingEnvironment): Promise<PendingOrder[]> {
    return this.client(environment).getOrders();
  }

  /** Ids of the orders currently pending at the broker. */
  async pendingOrderIds(environment: TradingEnvironment): Promise<Set<string>> {
    const orders = await this.client(environment).getOrders();
    return new Set(orders.map((order) => order.id).filter((id) => id !== undefined && id !== null).map(String));
  }

  /**
   * Final state of recent orders, keyed by order id, from the newest history pages. Paging stops once
   * every wanted id is found or the page reaches orders older than `since` (history allows few reads).
   */
  async recentOrderOutcomes(environment: TradingEnvironment, options: { wanted?: Iterable<string>; since?: string; maxPages?: number } = {}): Promise<Map<string, OrderOutcome>> {
    const client = this.client(environment);
    const outcomes = new Map<string, OrderOutcome>();
    // Fill totals per order, for the average price and the value in the account currency.
    const fills = new Map<string, { quantity: number; cost: number; priced: number; value: number; valued: number; count: number; currency?: string; at?: string }>();
    const wanted = new Set([...(options.wanted ?? [])].map(String));
    const since = options.since ? Date.parse(options.since) : NaN;
    let path: string | undefined;
    for (let page = 0; page < (options.maxPages ?? 4); page++) {
      const result = await client.getHistoryPage("orders", path);
      let oldest = Infinity;
      for (const item of result.items) {
        // An old order can fill recently, so a fill's time counts over the order's creation.
        const created = Date.parse(item.fill?.filledAt ?? item.order?.createdAt ?? "");
        if (Number.isFinite(created)) oldest = Math.min(oldest, created);
        const id = item.order?.id;
        if (id === undefined || id === null) continue;
        // Sells can be reported with negative quantities.
        const filled = Math.max(Math.abs(item.order?.filledQuantity ?? 0), Math.abs(item.fill?.quantity ?? 0));
        const previous = outcomes.get(String(id));
        const fill = item.fill;
        const totals = fills.get(String(id)) ?? { quantity: 0, cost: 0, priced: 0, value: 0, valued: 0, count: 0 };
        if (fill && Math.abs(fill.quantity ?? 0) > 0) {
          const quantity = Math.abs(fill.quantity!);
          totals.count++;
          totals.quantity += quantity;
          if (typeof fill.price === "number" && fill.price > 0) { totals.cost += quantity * fill.price; totals.priced += quantity; }
          if (typeof fill.walletImpact?.netValue === "number") { totals.value += Math.abs(fill.walletImpact.netValue); totals.valued++; }
          totals.currency ??= fill.walletImpact?.currency;
          if (fill.filledAt && (!totals.at || fill.filledAt > totals.at)) totals.at = fill.filledAt;
          fills.set(String(id), totals);
        }
        const ticker = item.order?.ticker ?? item.order?.instrument?.ticker ?? previous?.ticker;
        outcomes.set(String(id), {
          status: (item.order?.status ?? previous?.status ?? "").toUpperCase(),
          // Several fill rows add up when the order row does not give the filled total.
          filledQuantity: Math.max(filled, previous?.filledQuantity ?? 0, totals.quantity),
          quantity: Math.abs(item.order?.quantity ?? previous?.quantity ?? 0),
          ...(ticker ? { ticker } : {}),
          // The average is only given when every filled share has a price.
          ...(totals.priced > 0 && totals.priced >= totals.quantity * (1 - 1e-9) ? { averagePrice: Math.round((totals.cost / totals.priced) * 1e6) / 1e6 } : {}),
          ...(totals.count > 0 && totals.valued === totals.count ? { filledValue: Math.round(totals.value * 100) / 100, ...(totals.currency ? { filledValueCurrency: totals.currency } : {}) } : {}),
          ...(totals.at ? { filledAt: totals.at } : {}),
        });
      }
      if (!result.nextPagePath) break;
      if (wanted.size && [...wanted].every((id) => outcomes.has(id))) break;
      if (Number.isFinite(since) && oldest < since) break;
      path = result.nextPagePath;
    }
    return outcomes;
  }

  /**
   * Where one order stands: still open, or how it ended (filled, partly filled, cancelled, rejected),
   * with its fills. Reads the open orders, then the newest history pages until the id is found.
   */
  async orderStatus(environment: TradingEnvironment, orderId: string, maxPages = 4): Promise<OrderStatusReport> {
    const id = String(orderId).trim();
    if (!/^\d{1,20}$/.test(id)) fail("INVALID_INPUT", "orderId must be the numeric Trading 212 order id.", { field: "orderId" });
    const client = this.client(environment);
    const timestamp = new Date().toISOString();
    const open = (await client.getOrders()).find((order) => String(order.id) === id);
    if (open) return { kind: "order_status", environment, orderId: id, state: Math.abs(Number(open.filledQuantity ?? 0)) > 0 ? "partly_filled" : "open", order: open, fills: [], timestamp };
    const fills: OrderStatusReport["fills"] = [];
    let order: OrderStatusReport["order"];
    let path: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await client.getHistoryPage("orders", path);
      for (const item of result.items) {
        if (String(item.order?.id) !== id) continue;
        order ??= item.order as OrderStatusReport["order"];
        if (item.fill) fills.push({ ...(item.fill.filledAt ? { filledAt: item.fill.filledAt } : {}), ...(item.fill.quantity === undefined ? {} : { quantity: Math.abs(item.fill.quantity) }), ...(item.fill.price === undefined ? {} : { price: item.fill.price }), ...(item.fill.walletImpact?.netValue === undefined ? {} : { netValue: item.fill.walletImpact.netValue }), ...(item.fill.walletImpact?.currency ? { currency: item.fill.walletImpact.currency } : {}) });
      }
      // Fills of one order sit together, so the first page after it was found ends the search.
      if (order || !result.nextPagePath) break;
      path = result.nextPagePath;
    }
    if (!order) return { kind: "order_status", environment, orderId: id, state: "not_found", fills, timestamp };
    const status = String(order.status ?? "").toUpperCase();
    const filled = Math.max(Math.abs(Number(order.filledQuantity ?? 0)), fills.reduce((sum, fill) => sum + (fill.quantity ?? 0), 0));
    const quantity = Math.abs(Number(order.quantity ?? 0));
    // Fills come first: a broker can reject or cancel only the unfilled remainder of an order.
    const state: OrderStatusReport["state"] = filled > 0 && quantity > 0 && filled < quantity * (1 - 1e-6) ? "partly_filled"
      : filled > 0 || (/FILLED/.test(status) && !/UNFILLED|PARTIAL|REJECT/.test(status)) ? "filled"
      : /REJECT/.test(status) ? "rejected"
      : /CANCEL|EXPIRE/.test(status) ? "cancelled"
      : "closed";
    return { kind: "order_status", environment, orderId: id, state, order, fills, timestamp };
  }

  /** Cancel the surviving order of a protective pair. One request per call; the caller decides on retries. */
  async cancelLinkedOrder(environment: TradingEnvironment, orderId: string, reason: string, options: { quiet?: boolean } = {}): Promise<"cancelled" | "gone" | "unknown" | "rejected"> {
    try {
      await this.client(environment).cancelOrder(orderId);
      await this.recordActivity("protective_sibling_cancelled", environment, { orderId, outcome: reason.slice(0, 200) });
      return "cancelled";
    } catch (error) {
      // The order already left the book (filled or cancelled elsewhere): nothing is left to cancel.
      if (error instanceof Trading212ApiError && error.status === 404) return "gone";
      const unknown = error instanceof ExecutionStatusUnknownError;
      if (!options.quiet) await this.recordActivity(unknown ? "cancel_status_unknown" : "cancel_rejected", environment, { orderId, outcome: reason.slice(0, 200) });
      return unknown ? "unknown" : "rejected";
    }
  }

  async prepareCancel(environment: TradingEnvironment, orderId: string): Promise<CancelPreview> {
    const id = orderId.trim();
    if (!id) fail("INVALID_INPUT", "orderId is required", { field: "orderId" });
    const order = await this.client(environment).getOrder(id);
    const preview = { kind: "cancel_preview" as const, ...(await this.issue({ kind: "cancel", environment, orderId: id })), environment, orderId: id, ...(order && typeof order === "object" ? { order } : {}) };
    await this.recordActivity("cancel_prepared", environment, { orderId: id });
    return preview;
  }

  async executeCancel(confirmationId: string, options: { liveAcknowledged?: boolean } = {}): Promise<OrderExecutionResult> {
    const pending = await this.takePending(confirmationId, "cancel", !!options.liveAcknowledged);
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
        // Trading 212 reports sells with a negative quantity.
        if (typeof order.quantity === "number" && order.quantity !== 0 && (order.quantity < 0 ? "sell" : "buy") !== record.draft.side) return false;
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
