import type {
  AccountSummary,
  CancelPreview,
  DashboardPayload,
  EnrichedTradeCandidate,
  Instrument,
  OrderDraft,
  OrderExecutionResult,
  OrderIntent,
  OrderPreview,
  Position,
  ResolvedOrderIntent,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import { ExecutionStatusUnknownError, Trading212Client } from "./trading212-client.js";
import { randomToken } from "./web-utils.js";

type Audit = (event: string, details: Record<string, unknown>) => Promise<void>;
type Pending = { kind: "order"; draft: OrderDraft } | { kind: "cancel"; environment: TradingEnvironment; orderId: string };
export interface InstrumentCacheEntry { expiresAt: number; instruments: Instrument[] }
export type InstrumentCache = Map<TradingEnvironment, InstrumentCacheEntry>;
export interface TradingServiceDeps { config: RuntimeConfig; store: StateStore; audit?: Audit; fetcher?: typeof fetch; instrumentCache?: InstrumentCache }

function positiveNumber(name: string, value?: number): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

function floorQuantity(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
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

  const names = instruments.filter((item) => `${item.name ?? ""} ${item.shortName ?? ""}`.toUpperCase().includes(q));
  if (names.length === 1) return names[0]!;
  if (names.length > 1) throw new Error(`Instrument ${query} is ambiguous. Use an exact ticker: ${names.slice(0, 8).map((item) => item.ticker).join(", ")}`);
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

  const price = draft.type === "limit" || draft.type === "stop_limit"
    ? draft.limitPrice
    : draft.type === "stop"
      ? draft.stopPrice
      : draft.referencePrice ?? position?.currentPrice;
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

export class TradingService {
  private readonly cache: InstrumentCache;

  constructor(private readonly deps: TradingServiceDeps) {
    this.cache = deps.instrumentCache ?? new Map();
  }

  private client(environment: TradingEnvironment) {
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
  }

  private async instruments(environment: TradingEnvironment) {
    const cached = this.cache.get(environment);
    if (cached && cached.expiresAt > Date.now()) return cached.instruments;
    const instruments = await this.client(environment).getInstruments();
    this.cache.set(environment, { instruments, expiresAt: Date.now() + 600_000 });
    return instruments;
  }

  private positionFor(positions: Position[], ticker: string) {
    return positions.find((position) => position.instrument?.ticker.toUpperCase() === ticker.toUpperCase());
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
        timestamp: new Date().toISOString(),
        warning: `${environment.toUpperCase()} credentials are not configured`,
      };
    }
    const client = this.client(environment);
    const [account, positions, orders] = await Promise.all([client.getAccountSummary(), client.getPositions(), client.getOrders()]);
    return { kind: "portfolio", appName: "TradePilot 212", environment, credentials, account, positions, orders, timestamp: new Date().toISOString() };
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
      const available = position?.quantityAvailableForTrading ?? 0;
      if (available <= 0) throw new Error(`There is no tradable ${instrument.ticker} position to sell`);
      quantity = sizing.percent === 100 ? available : floorQuantity(available * sizing.percent / 100);
      if (quantity <= 0) throw new Error("The requested position percentage is too small to produce a tradable quantity");
      referencePrice ??= position?.currentPrice;
      note = `Sell ${sizing.percent}% of the currently tradable position: ${quantity} share(s).`;
    } else if (sizing.mode === "all_available") {
      if (intent.side !== "sell") throw new Error("all_available sizing is only valid for sell orders");
      const available = position?.quantityAvailableForTrading ?? 0;
      if (available <= 0) throw new Error(`There is no tradable ${instrument.ticker} position to sell`);
      quantity = available;
      referencePrice ??= position?.currentPrice;
      note = `Sell all currently tradable shares: ${quantity}.`;
    } else {
      positiveNumber("amount", sizing.amount);
      const pricingReference = referencePrice
        ?? (intent.type === "limit" || intent.type === "stop_limit" ? intent.limitPrice : undefined)
        ?? (intent.type === "stop" ? intent.stopPrice : undefined)
        ?? position?.currentPrice;
      positiveNumber("referencePrice", pricingReference);
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
    return { instrument, position, ...validateOrderAgainstSnapshot(draft, instrument, position, account, this.deps.config) };
  }

  private async issue(value: Pending) {
    const token = randomToken();
    const expiresAt = Date.now() + this.deps.config.confirmationTtlSeconds * 1000;
    await this.deps.store.put(`confirm:${token}`, value, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async prepareOrder(raw: OrderDraft): Promise<OrderPreview> {
    const draft = { ...raw, ticker: raw.ticker.trim() };
    const current = await this.current(draft);
    const warnings: string[] = [];
    if (draft.environment === "live") warnings.push("LIVE: this uses real money when you confirm.");
    if (current.estimatedNotional === undefined) {
      warnings.push("No reference price was supplied, so the app cannot estimate the order amount before submission. Trading 212 remains the final funds check.");
    } else if (!current.cashCheckApplied && draft.side === "buy") {
      warnings.push(`The instrument is priced in ${current.estimatedNotionalCurrency} while the account cash is ${current.accountCurrency ?? "another currency"}. The app-level notional cap was applied; Trading 212 remains the final funds check.`);
    }
    if (draft.type === "market") warnings.push("Market orders can execute away from the reference price because of slippage.");
    const confirmation = await this.issue({ kind: "order", draft });
    await this.deps.audit?.("order_prepared", { environment: draft.environment, ticker: draft.ticker, expiresAt: confirmation.expiresAt });
    return {
      kind: "order_preview",
      ...confirmation,
      draft,
      instrument: current.instrument,
      ...(current.estimatedNotional === undefined ? {} : { estimatedNotional: current.estimatedNotional }),
      estimatedNotionalCurrency: current.estimatedNotionalCurrency,
      ...(current.accountCurrency ? { accountCurrency: current.accountCurrency } : {}),
      ...(current.availableCash === undefined ? {} : { availableCash: current.availableCash }),
      ...(current.position ? { availableToSell: current.position.quantityAvailableForTrading } : {}),
      warnings,
    };
  }

  async executeOrder(token: string): Promise<OrderExecutionResult> {
    const pending = await this.deps.store.consume<Pending>(`confirm:${token}`);
    if (!pending || pending.kind !== "order") throw new Error("Confirmation token is invalid or expired");
    const draft = pending.draft;
    try {
      await this.current(draft);
      const order = await this.client(draft.environment).placeOrder(draft);
      await this.deps.audit?.("order_submitted", { environment: draft.environment, ticker: draft.ticker });
      return { kind: "order_execution", environment: draft.environment, ok: true, status: "submitted", order, message: `${draft.environment.toUpperCase()} order submitted to Trading 212` };
    } catch (error) {
      const unknown = error instanceof ExecutionStatusUnknownError;
      await this.deps.audit?.(unknown ? "order_status_unknown" : "order_rejected", { environment: draft.environment, ticker: draft.ticker });
      return { kind: "order_execution", environment: draft.environment, ok: false, status: unknown ? "unknown" : "rejected", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async prepareCancel(environment: TradingEnvironment, orderId: string): Promise<CancelPreview> {
    const id = orderId.trim();
    if (!id) throw new Error("orderId is required");
    await this.client(environment).getOrder(id);
    return { kind: "cancel_preview", ...(await this.issue({ kind: "cancel", environment, orderId: id })), environment, orderId: id };
  }

  async executeCancel(token: string): Promise<OrderExecutionResult> {
    const pending = await this.deps.store.consume<Pending>(`confirm:${token}`);
    if (!pending || pending.kind !== "cancel") throw new Error("Confirmation token is invalid or expired");
    try {
      const order = await this.client(pending.environment).cancelOrder(pending.orderId);
      await this.deps.audit?.("order_cancelled", { environment: pending.environment, orderId: pending.orderId });
      return { kind: "order_execution", environment: pending.environment, ok: true, status: "submitted", order, message: `${pending.environment.toUpperCase()} cancel submitted` };
    } catch (error) {
      const unknown = error instanceof ExecutionStatusUnknownError;
      return { kind: "order_execution", environment: pending.environment, ok: false, status: unknown ? "unknown" : "rejected", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
