import type { PolicyCheck } from "./automation.js";
import type { ValuePoint } from "./history.js";

export type TradingEnvironment = "demo" | "live";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeValidity = "DAY" | "GOOD_TILL_CANCEL";
export type Horizon = "short" | "medium" | "long";
export type CandidateAction = "buy" | "sell" | "watch";

export type TradePilotErrorCode =
  | "INVALID_INPUT"
  | "CREDENTIALS_NOT_CONFIGURED"
  | "INSTRUMENT_NOT_FOUND"
  | "INSTRUMENT_AMBIGUOUS"
  | "NO_AVAILABLE_POSITION"
  | "NO_AVAILABLE_CASH"
  | "INSUFFICIENT_SELLABLE_QUANTITY"
  | "INSUFFICIENT_CASH"
  | "ORDER_NOTIONAL_LIMIT"
  | "ORDER_QUANTITY_LIMIT"
  | "FX_RATE_REQUIRED"
  | "PRICE_OUT_OF_RANGE"
  | "REFERENCE_PRICE_REQUIRED"
  | "UNSUPPORTED_EXTENDED_HOURS"
  | "CONFIRMATION_EXPIRED"
  | "VERIFICATION_NOT_FOUND"
  | "POLICY_BLOCKED"
  | "LIVE_ACK_REQUIRED"
  | "PLAN_NOT_FOUND"
  | "PIE_NOT_FOUND"
  | "ALERT_NOT_FOUND"
  | "JOURNAL_ENTRY_NOT_FOUND"
  | "BROKER_RATE_LIMITED"
  | "BROKER_REQUEST_FAILED"
  | "EXECUTION_STATUS_UNKNOWN"
  | "EXECUTION_BUSY"
  | "RISK_CHANGED"
  | "RISK_CHECK_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface StructuredError {
  code: TradePilotErrorCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ErrorPayload {
  kind: "error";
  message: string;
  error: StructuredError;
}

export interface CredentialStatus {
  demo: boolean;
  live: boolean;
  /** The Demo account is TradePilot's simulated sample account, not Trading 212. */
  sample?: boolean;
}

export interface Instrument {
  ticker: string;
  name: string;
  shortName: string;
  currencyCode: string;
  isin?: string;
  type?: string;
  maxOpenQuantity?: number;
  extendedHours?: boolean;
  workingScheduleId?: number;
  addedOn?: string;
}

export interface PositionWalletImpact {
  [key: string]: unknown;
}

export interface Position {
  instrument: Instrument;
  quantity: number;
  quantityAvailableForTrading: number;
  quantityInPies: number;
  averagePricePaid: number;
  currentPrice: number;
  walletImpact?: PositionWalletImpact;
  createdAt?: string;
}

export interface AccountSummary {
  id?: number;
  currency?: string;
  totalValue?: number;
  cash?: {
    availableToTrade?: number;
    inPies?: number;
    reservedForOrders?: number;
  };
  investments?: {
    currentValue?: number;
    realizedProfitLoss?: number;
    totalCost?: number;
    unrealizedProfitLoss?: number;
  };
}

export interface PendingOrder {
  id?: number | string;
  ticker?: string;
  /** Negative for sells. */
  quantity?: number;
  filledQuantity?: number;
  /** "QUANTITY", or "VALUE" for orders placed by amount in the Trading 212 app. */
  strategy?: string;
  /** Order amount for VALUE orders. */
  value?: number;
  side?: string;
  status?: string;
  type?: string;
  limitPrice?: number;
  stopPrice?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export type ActivityType =
  | "order_prepared"
  | "order_submitted"
  | "order_rejected"
  | "order_status_unknown"
  | "order_verification"
  | "order_filled"
  | "order_partly_filled"
  | "order_closed"
  | "order_outcome_unknown"
  | "cancel_prepared"
  | "cancel_submitted"
  | "cancel_rejected"
  | "cancel_status_unknown"
  | "basket_prepared"
  | "basket_submitted"
  | "plan_due"
  | "plan_auto_executed"
  | "plan_skipped"
  | "protective_linked"
  | "protective_sibling_cancelled"
  | "protective_unlinked"
  | "protective_attention"
  | "pie_prepared"
  | "pie_submitted"
  | "pie_rejected"
  | "pie_status_unknown"
  | "price_alert_triggered"
  | "allocation_drift"
  | "daily_digest";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  environment: TradingEnvironment;
  type: ActivityType;
  ticker?: string;
  orderId?: string;
  side?: OrderSide;
  orderType?: OrderType;
  quantity?: number;
  outcome?: string;
  planId?: string;
  legs?: number;
  pieId?: number;
  alertId?: string;
  /** A price: the alert's, or an order's average fill price in the instrument's currency. */
  price?: number;
  /** Shares filled, when an order filled fully or partly. */
  filledQuantity?: number;
  /** Value of the fills in the account currency. */
  value?: number;
  valueCurrency?: string;
}

export interface PortfolioSnapshot {
  kind: "portfolio";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  account: AccountSummary | null;
  positions: Position[];
  orders: PendingOrder[];
  activity?: ActivityEvent[];
  /** The account value TradePilot recorded over the last 30 days, oldest first, when it has two days or more. */
  valueTrend?: ValuePoint[];
  timestamp: string;
  warning?: string;
}

export interface TradeCandidate {
  ticker?: string;
  symbol?: string;
  name?: string;
  horizon: Horizon;
  action: CandidateAction;
  score: number;
  rationale: string;
  risk: "low" | "medium" | "high";
  suggestedQuantity?: number;
  referencePrice?: number;
  referencePriceAt?: string;
  analysisAsOf?: string;
  thesis?: string;
  catalysts?: string[];
  risks?: string[];
  counterCase?: string;
  sources?: string[];
}

export interface EnrichedTradeCandidate extends TradeCandidate {
  resolvedInstrument?: Instrument;
  resolutionError?: string;
  heldQuantity?: number;
  availableToSell?: number;
}

export interface TradePlanPayload {
  kind: "trade_plan";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  candidates: EnrichedTradeCandidate[];
  account: AccountSummary | null;
  timestamp: string;
}

export interface OrderDraft {
  environment: TradingEnvironment;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  extendedHours?: boolean;
  timeValidity?: TimeValidity;
  limitPrice?: number;
  stopPrice?: number;
  referencePrice?: number;
  referencePriceAt?: string;
  /**
   * Instrument-currency units per 1 account-currency unit, from a dated source (`fxRateAt`). Used only
   * when no holding implies a rate, e.g. the first purchase of an instrument quoted in a new currency.
   */
  fxRate?: number;
  fxRateAt?: string;
  /**
   * True when `fxRate` came from the quote source rather than from you. A risk-sized buy whose rate came from
   * there is refused when the source has no rate at its review, rather than checked at the old one.
   */
  fxRateQuoted?: boolean;
  /**
   * What a risk-sized buy may lose at its stop-loss: the stop-loss price (instrument currency) and the
   * budget (account currency). The review checks the loss again at the prices of the moment.
   */
  riskBudget?: { stopLossPrice: number; budget: number };
  /** Why you are making this trade. Never sent to Trading 212; saved to the trade journal once the order is sent. */
  thesis?: string;
}

export type OrderSizing =
  | { mode: "quantity"; quantity: number }
  | { mode: "notional"; amount: number; currency?: string; fxRateToInstrumentCurrency?: number }
  | { mode: "cash_percent"; percent: number; fxRateToInstrumentCurrency?: number }
  | { mode: "position_percent"; percent: number }
  | { mode: "all_available" }
  /**
   * Buy as many shares as would lose `amount` (in the account currency), or `percent` of the account value,
   * if the price fell from the entry to `stopLossPrice`. Give one of amount and percent.
   */
  | { mode: "risk"; stopLossPrice: number; amount?: number; percent?: number; fxRateToInstrumentCurrency?: number };

export interface OrderIntent {
  environment: TradingEnvironment;
  instrument: string;
  side: OrderSide;
  type: OrderType;
  sizing: OrderSizing;
  extendedHours?: boolean;
  timeValidity?: TimeValidity;
  limitPrice?: number;
  stopPrice?: number;
  referencePrice?: number;
  referencePriceAt?: string;
  /** Instrument-currency units per 1 account-currency unit, for an instrument quoted in a currency you hold nothing in. */
  fxRate?: number;
  fxRateAt?: string;
  /** Why you are making this trade; it travels with the draft and is saved to the trade journal once sent. */
  thesis?: string;
}

export interface ResolvedOrderIntent {
  draft: OrderDraft;
  instrument: Instrument;
  sizing: OrderSizing;
  accountCurrency?: string;
  heldQuantity?: number;
  availableToSell?: number;
  requestedNotional?: number;
  requestedNotionalCurrency?: string;
  estimatedQuoteNotional?: number;
  risk?: RiskSizing;
  note: string;
}

/** How a risk-sized buy came out, so the editor can show the loss at the stop as the quantity changes. */
export interface RiskSizing {
  /** The most the buy should lose at the stop, in the account currency. */
  budget: number;
  /**
   * The price the quantity was sized at, the worst the buy can fill at: the limit, or for a Market or Stop buy
   * the higher of the price given (or the trigger) and the last price.
   */
  entryPrice: number;
  /**
   * The last price when it was sized, which a Market or triggered Stop buy fills near: the holding's, or the
   * quote source's for an instrument you do not hold.
   */
  currentPrice?: number;
  /** Account-currency loss per share from entryPrice down to the stop. */
  perShare: number;
  /** The available cash, not the budget, set the quantity. */
  cashCapped?: boolean;
}

export interface OrderResolution {
  sizing: OrderSizing;
  resolvedQuantity: number;
  accountCurrency?: string;
  heldQuantity?: number;
  availableToSell?: number;
  requestedNotional?: number;
  requestedNotionalCurrency?: string;
  estimatedQuoteNotional?: number;
  risk?: RiskSizing;
}

export interface OrderDraftPayload {
  kind: "order_draft";
  draft: OrderDraft;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  resolvedInstrument?: Instrument;
  resolution?: OrderResolution;
  note?: string;
}

export type OrderNoticeCode =
  | "LIVE_FUNDS"
  | "MARKET_SLIPPAGE"
  | "REFERENCE_PRICE_STALE"
  | "REFERENCE_PRICE_TIME_UNKNOWN"
  | "FX_RATE_STALE"
  | "CROSS_CURRENCY_FUNDS_CHECK"
  | "NOTIONAL_ESTIMATE_UNAVAILABLE"
  | "MARKET_CLOSED"
  | "MARKET_CLOSED_QUEUED"
  | "MARKET_HOURS_UNKNOWN"
  | "STOP_ALREADY_TRIGGERED"
  | "LIMIT_FILLS_AT_ONCE"
  | "PRICE_FAR_FROM_LAST"
  | "RISK_OVER_BUDGET"
  | "RISK_STOP_ABOVE_PRICE"
  | "STOP_SLIPPAGE";

export interface OrderNotice {
  code: OrderNoticeCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface OrderPreview {
  kind: "order_preview";
  token: string;
  expiresAt: string;
  snapshotAt: string;
  draft: OrderDraft;
  instrument: Instrument;
  estimatedNotional?: number;
  estimatedNotionalCurrency: string;
  /** The estimate converted to the account currency, when the instrument is quoted in another one. */
  estimatedAccountNotional?: number;
  accountCurrency?: string;
  availableCash?: number;
  availableToSell?: number;
  notices: OrderNotice[];
  /** Policy rules evaluated for this order; blocked orders never get a token. */
  policy?: PolicyCheck[];
  warnings?: string[];
}

export interface OrderExecutionResult {
  kind: "order_execution";
  environment: TradingEnvironment;
  ok: boolean;
  status: "submitted" | "unknown" | "rejected";
  order?: unknown;
  message: string;
  error?: StructuredError;
  verificationId?: string;
  /** The trade journal note the order's thesis was saved to. */
  journalEntryId?: string;
}

export type ExecutionVerificationStatus =
  | "confirmed_pending"
  | "likely_executed"
  | "still_pending"
  | "no_longer_pending"
  | "no_evidence"
  | "indeterminate";

export interface ExecutionVerificationResult {
  kind: "execution_verification";
  verificationId: string;
  environment: TradingEnvironment;
  operation: "order" | "cancel";
  status: ExecutionVerificationStatus;
  checkedAt: string;
  ticker?: string;
  orderId?: string;
  positionDelta?: number;
  message: string;
}

export interface CancelPreview {
  kind: "cancel_preview";
  token: string;
  expiresAt: string;
  environment: TradingEnvironment;
  orderId: string;
  /** The order as Trading 212 reports it, so the confirmation can say what is being cancelled. */
  order?: PendingOrder;
}

export interface DashboardPayload extends PortfolioSnapshot {
  appName: "TradePilot 212";
}

export interface CancelDraftPayload {
  kind: "cancel_draft";
  environment: TradingEnvironment;
  orderId: string;
  /** The pending order as Trading 212 lists it, when it is still open. */
  order?: PendingOrder;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
}
