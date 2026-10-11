// Contracts for the policy engine, multi-order baskets, rebalancing and standing (DCA) plans.

import type { CredentialStatus, Instrument, OrderDraft, OrderExecutionResult, OrderNotice, TradingEnvironment } from "./contracts.js";

/** Account-level trading rules. A zero or empty value disables that rule. */
export interface TradingPolicy {
  /** Largest share of total account value one instrument may reach after a buy (0 to 1). */
  maxPositionWeight: number;
  /** Orders submitted through TradePilot per environment per UTC day. */
  dailyOrderLimit: number;
  /** Estimated notional submitted per UTC day, counted only when instrument and account currency match. */
  dailyNotionalLimit: number;
  /** When non-empty, only these tickers (exact Trading 212 tickers) may be traded. */
  allowedTickers: string[];
  blockedTickers: string[];
  /** When non-empty, only these instrument types (e.g. ETF, STOCK) may be bought. */
  allowedTypes: string[];
  /** false blocks Market orders while the regular session is closed, so they cannot fill at a gap price. */
  marketOrdersWhenClosed: boolean;
  /** Block when the reference price is older than this many seconds (0 only warns). */
  maxReferenceAgeSeconds: number;
}

export type PolicyRule =
  | "allowed_tickers"
  | "blocked_tickers"
  | "allowed_types"
  | "max_position_weight"
  | "daily_order_limit"
  | "daily_notional_limit"
  | "market_closed"
  | "reference_age";

export interface PolicyCheck {
  rule: PolicyRule;
  status: "pass" | "warn" | "block" | "skip";
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface BasketLeg {
  draft: OrderDraft;
  instrument?: Instrument;
  estimatedNotional?: number;
  estimatedNotionalCurrency?: string;
  /** Why this leg exists, e.g. "rebalance to 30%" or "stop-loss". */
  reason?: string;
}

export type BasketPurpose = "rebalance" | "protective" | "dca" | "custom";

export interface BasketDraftPayload {
  kind: "basket_draft";
  environment: TradingEnvironment;
  purpose: BasketPurpose;
  title: string;
  legs: BasketLeg[];
  notes: string[];
  planId?: string;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
}

export interface BasketPreview {
  kind: "basket_preview";
  token: string;
  expiresAt: string;
  snapshotAt: string;
  environment: TradingEnvironment;
  purpose: BasketPurpose;
  title: string;
  legs: Array<BasketLeg & { notices: OrderNotice[]; policy: PolicyCheck[] }>;
  notes: string[];
  planId?: string;
}

export interface BasketExecutionResult {
  kind: "basket_execution";
  environment: TradingEnvironment;
  purpose: BasketPurpose;
  ok: boolean;
  /** "partial" means some legs were submitted and a later one failed or was not attempted. */
  status: "submitted" | "partial" | "stopped" | "rejected";
  legs: Array<{ draft: OrderDraft; result?: OrderExecutionResult; skipped?: string }>;
  message: string;
}

export interface RebalanceTarget {
  ticker: string;
  /** Target share of total account value (0 to 1). */
  weight: number;
  /** Price for an instrument you do not hold yet; Trading 212 has no quote endpoint. */
  referencePrice?: number;
  /** When referencePrice is from; without it the order review treats the price as undated. */
  referencePriceAt?: string;
}

export interface RebalanceTrade {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  /** Currency of price (the instrument's quote currency). */
  currency?: string;
  /** When the price is from: now for broker prices, the quote time for external quotes. */
  priceAt?: string;
  value: number;
  currentWeight: number;
  targetWeight: number;
  resultingWeight: number;
}

export interface RebalancePlan {
  kind: "rebalance_plan";
  environment: TradingEnvironment;
  accountCurrency: string;
  totalValue: number;
  cashBefore: number;
  cashAfter: number;
  trades: RebalanceTrade[];
  skipped: Array<{ ticker: string; reason: string }>;
  notes: string[];
}

export type PlanFrequency = "weekly" | "monthly";

export interface DcaLeg {
  ticker: string;
  /** Amount in the account currency per run. */
  amount: number;
  /** "market" (default) or "limit": a Day Limit buy at the last price plus limitOffsetPercent. */
  orderType?: "market" | "limit";
  /** Limit legs only: how far above the last broker price the limit sits, 0 to 10 (default 0.5). */
  limitOffsetPercent?: number;
}

export interface DcaPlan {
  id: string;
  environment: TradingEnvironment;
  label: string;
  legs: DcaLeg[];
  frequency: PlanFrequency;
  /** 1-28 for monthly plans. */
  dayOfMonth?: number;
  /** 1 (Monday) to 7 (Sunday) for weekly plans. */
  weekday?: number;
  /** UTC hour the plan becomes due; pick one inside the instruments' regular session. */
  hourUtc: number;
  /** Demo only: execute without a person when due and the policy allows. */
  autoExecute: boolean;
  paused: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastOutcome?: string;
  createdAt: string;
}

export interface PlanRunReport {
  planId: string;
  environment: TradingEnvironment;
  dueAt: string;
  mode: "auto" | "awaiting_confirmation" | "skipped";
  message: string;
  result?: BasketExecutionResult;
}

/** A stop-loss and take-profit pair; when one fills, the scheduler cancels the other. */
export interface ProtectiveLink {
  id: string;
  environment: TradingEnvironment;
  ticker: string;
  orders: [{ orderId: string; role: "stop_loss" | "take_profit" }, { orderId: string; role: "stop_loss" | "take_profit" }];
  createdAt: string;
}

/**
 * A price alert on a holding, checked every scheduler tick against the broker's last position price
 * (Trading 212 has no quote endpoint, so only held instruments have a price). Alerts notify; they
 * never place orders.
 */
export type AlertCondition = "above" | "below" | "trailing_drop" | "gain_percent" | "loss_percent";

export interface PriceAlert {
  id: string;
  environment: TradingEnvironment;
  ticker: string;
  condition: AlertCondition;
  /** Price for above/below, in the instrument currency. */
  price?: number;
  /** Percent for trailing_drop (from the highest price seen), gain_percent and loss_percent (from the average cost). */
  percent?: number;
  /** Highest price seen since the alert was armed; trailing_drop only. */
  highWatermark?: number;
  note?: string;
  createdAt: string;
  lastPrice?: number;
  lastCheckedAt?: string;
  triggeredAt?: string;
  triggeredPrice?: number;
}

/** Everything the scheduler acts on, for one environment, in one payload for the widget. */
export interface AutomationOverview {
  kind: "automation";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  plans: DcaPlan[];
  alerts: PriceAlert[];
  links: ProtectiveLink[];
  usageToday: { orders: number; notional: number };
  /** Account currency of plan amounts and daily value, when known. */
  currency?: string;
  policy: TradingPolicy;
  settings: {
    demoAutomation: boolean;
    protectiveLinking: boolean;
    webhook: boolean;
    digestHourUtc: number | null;
    quoteProvider: string;
  };
  timestamp: string;
}

export interface AlertReport {
  alertId: string;
  environment: TradingEnvironment;
  ticker: string;
  action: "triggered" | "waiting" | "no_price";
  message: string;
}
