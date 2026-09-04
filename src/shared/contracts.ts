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
  | "REFERENCE_PRICE_REQUIRED"
  | "UNSUPPORTED_EXTENDED_HOURS"
  | "CONFIRMATION_EXPIRED"
  | "VERIFICATION_NOT_FOUND"
  | "BROKER_RATE_LIMITED"
  | "BROKER_REQUEST_FAILED"
  | "EXECUTION_STATUS_UNKNOWN"
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
  quantity?: number;
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
  | "cancel_prepared"
  | "cancel_submitted"
  | "cancel_rejected"
  | "cancel_status_unknown";

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
  fxRateAt?: string;
}

export type OrderSizing =
  | { mode: "quantity"; quantity: number }
  | { mode: "notional"; amount: number; currency?: string; fxRateToInstrumentCurrency?: number }
  | { mode: "cash_percent"; percent: number; fxRateToInstrumentCurrency?: number }
  | { mode: "position_percent"; percent: number }
  | { mode: "all_available" };

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
  fxRateAt?: string;
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
  note: string;
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
  | "NOTIONAL_ESTIMATE_UNAVAILABLE";

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
  accountCurrency?: string;
  availableCash?: number;
  availableToSell?: number;
  notices: OrderNotice[];
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
}

export interface DashboardPayload extends PortfolioSnapshot {
  appName: "TradePilot 212";
}
