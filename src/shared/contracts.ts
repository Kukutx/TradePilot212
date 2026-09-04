export type TradingEnvironment = "demo" | "live";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeValidity = "DAY" | "GOOD_TILL_CANCEL";
export type Horizon = "short" | "medium" | "long";
export type CandidateAction = "buy" | "sell" | "watch";

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

export interface PortfolioSnapshot {
  kind: "portfolio";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  account: AccountSummary | null;
  positions: Position[];
  orders: PendingOrder[];
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
}

export interface OrderPreview {
  kind: "order_preview";
  token: string;
  expiresAt: string;
  draft: OrderDraft;
  instrument: Instrument;
  estimatedNotional: number;
  estimatedNotionalCurrency: string;
  accountCurrency?: string;
  availableCash?: number;
  availableToSell?: number;
  warnings: string[];
}

export interface OrderExecutionResult {
  kind: "order_execution";
  environment: TradingEnvironment;
  ok: boolean;
  status: "submitted" | "unknown" | "rejected";
  order?: unknown;
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
