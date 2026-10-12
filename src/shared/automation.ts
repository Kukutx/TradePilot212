// Contracts for the policy engine, multi-order baskets, rebalancing and standing (DCA) plans.

import type { CredentialStatus, Instrument, OrderDraft, OrderExecutionResult, OrderNotice, TradingEnvironment } from "./contracts.js";
import type { TradeTotals } from "./trade-cost.js";

/** The note every basket preview carries for text-only hosts; the widget shows its own translation. */
export const BASKET_ORDER_NOTE = "Orders are sent one at a time, sells first. If a result is uncertain, the remaining orders are not sent.";

/** Account-level trading rules. A zero or empty value disables that rule. */
export interface TradingPolicy {
  /** Largest share of total account value one instrument may reach after a buy (0 to 1). */
  maxPositionWeight: number;
  /** Orders submitted through TradePilot per environment per UTC day. */
  dailyOrderLimit: number;
  /** Estimated value submitted per UTC day, in the account currency (other currencies converted at the rate holdings imply). */
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
  /** The estimate in the account currency, when the instrument is quoted in another one. */
  estimatedAccountNotional?: number;
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
  accountCurrency?: string;
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

export type RebalanceSkipCode = "no_fx_rate" | "no_price" | "below_one_share" | "below_minimum";
export type RebalanceNoteCode = "untargeted_kept" | "sell_limited" | "buys_scaled" | "buy_only" | "amount_capped" | "no_cash" | "implied_rates" | "quoted_rates" | "nothing_possible" | "within_threshold" | "price_source" | "fx_fee";

/** A plan note with the facts behind it, so the widget can say it in its own language. */
export interface RebalanceNote {
  code: RebalanceNoteCode;
  message: string;
  details?: Record<string, string | number>;
}

export interface RebalancePlan {
  kind: "rebalance_plan";
  environment: TradingEnvironment;
  accountCurrency: string;
  totalValue: number;
  cashBefore: number;
  cashAfter: number;
  /** Only buys, from cash above the reserve; nothing is sold. */
  buyOnly?: boolean;
  trades: RebalanceTrade[];
  /** What the trades buy and sell, and the conversion fee on the part in other currencies: from 2.52. */
  totals?: TradeTotals;
  skipped: Array<{ ticker: string; reason: string; code?: RebalanceSkipCode; currency?: string }>;
  notes: string[];
  /** The same notes as `notes`, in order, with their codes and values. */
  noteDetails?: RebalanceNote[];
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
  /** Fixed buys per run; empty when the plan invests targetAmount across the saved targets. */
  legs: DcaLeg[];
  /**
   * Amount in the account currency to invest each run across the saved target weights, most
   * underweight first. The split is worked out from the account when the plan runs.
   */
  targetAmount?: number;
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
  /**
   * Set while an unattended run of this due date is being sent. If it is still set on a later tick,
   * that run may have reached the broker, so the plan waits for you instead of sending again.
   */
  inFlightDueAt?: string;
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
  /** Failed attempts to cancel the surviving order after the other one filled. */
  cancelAttempts?: number;
}

/**
 * A price alert on a holding, checked every scheduler tick against the broker's last position price
 * (Trading 212 has no quote endpoint, so only held instruments have a price). Alerts notify; they
 * never place orders. day_move fires when the price is a percent or more above or below the previous
 * close, once per trading day.
 */
export type AlertCondition = "above" | "below" | "trailing_drop" | "gain_percent" | "loss_percent" | "day_move";

export interface PriceAlert {
  id: string;
  environment: TradingEnvironment;
  ticker: string;
  condition: AlertCondition;
  /** Price for above/below, in the instrument currency. */
  price?: number;
  /**
   * Percent for trailing_drop (from the highest price seen), gain_percent and loss_percent (from the average cost),
   * and day_move (either way from the previous close).
   */
  percent?: number;
  /** Highest price seen since the alert was armed; trailing_drop only. */
  highWatermark?: number;
  note?: string;
  createdAt: string;
  lastPrice?: number;
  lastCheckedAt?: string;
  triggeredAt?: string;
  triggeredPrice?: number;
  /** When it last fired before it was armed again (by hand, or a day's move on its next day): the daily digest counts it. */
  lastTriggeredAt?: string;
  /** day_move: the trading day it fired on; it arms itself again on the next one. */
  triggeredDay?: string;
  /** day_move: the last price's change from the previous close, and that close's date. */
  lastDayChange?: number;
  lastCloseDate?: string;
}

/**
 * An alert on the account as a whole, checked every scheduler tick against Trading 212's account summary: its total
 * value or its free cash at or above, or at or below, an amount in the account currency. day_move fires when the
 * holdings' move on the day, as get_portfolio_today adds it up, is a percent or more either way, once per trading
 * day. Alerts notify; they never place orders.
 */
export type AccountAlertCondition = "value_above" | "value_below" | "cash_above" | "cash_below" | "day_move";

export interface AccountAlert {
  id: string;
  environment: TradingEnvironment;
  condition: AccountAlertCondition;
  /** The amount for the value and cash conditions, in the account currency. */
  amount?: number;
  /** The percent for day_move, either way. */
  percent?: number;
  /** The account currency when the alert was saved. */
  currency?: string;
  note?: string;
  createdAt: string;
  /** The last total value, free cash or day's change (a fraction) read, and when. */
  lastValue?: number;
  lastCheckedAt?: string;
  triggeredAt?: string;
  triggeredValue?: number;
  /** When it last fired before it was armed again (by hand, or a day's move on its next day): the daily digest counts it. */
  lastTriggeredAt?: string;
  /** day_move: the trading day it fired on; it arms itself again on the next one. */
  triggeredDay?: string;
  /** day_move: the trading day of the last change read. */
  lastDay?: string;
}

export interface AccountAlertReport {
  alertId: string;
  environment: TradingEnvironment;
  action: "triggered" | "waiting";
  message: string;
}

/**
 * Target weights saved for one environment. The scheduler compares them with the account and notifies
 * when a holding or cash drifts too far; plan_portfolio_rebalance uses them when no targets are passed.
 */
export interface TargetAllocation {
  environment: TradingEnvironment;
  /** Shares of total account value, by exact Trading 212 ticker. */
  targets: Array<{ ticker: string; weight: number }>;
  /** Share of total account value meant to stay in cash. */
  cashWeight: number;
  /** Drift in weight points (0.05 = 5 points) above which the scheduler notifies. */
  driftThreshold: number;
  /** Holdings without a target are sold by a rebalance to these targets, and count as drift; kept by default. */
  sellUntargeted?: boolean;
  updatedAt: string;
  /** When the scheduler last sent a drift notice; at most one a day while the drift lasts. */
  lastNotifiedAt?: string;
}

/** Everything the scheduler acts on, for one environment, in one payload for the widget. */
export interface AutomationOverview {
  kind: "automation";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  plans: DcaPlan[];
  alerts: PriceAlert[];
  /** Alerts on the account's value, cash and day's move. */
  accountAlerts?: AccountAlert[];
  /** The account's total value and free cash now, for an account alert's starting amount. */
  account?: { value?: number; cash?: number };
  links: ProtectiveLink[];
  /** Saved target weights, when there are any. */
  targets?: TargetAllocation;
  /** The instruments the plans, alerts, links and targets name, for their names and quote currencies. */
  instruments?: Array<Pick<Instrument, "ticker"> & Partial<Pick<Instrument, "name" | "shortName" | "currencyCode" | "type">>>;
  usageToday: { orders: number; notional: number };
  /** Account currency of plan amounts and daily value, when known. */
  currency?: string;
  policy: TradingPolicy;
  settings: {
    demoAutomation: boolean;
    protectiveLinking: boolean;
    /** Open orders are watched and how each ended is reported. */
    orderWatch: boolean;
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
