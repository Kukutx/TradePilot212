// Trading 212 history, schedule, and report shapes, plus the analytics payloads built from them.
// Broker fields are optional because the Public API is still marked Beta and omits empty values.

import type { TradingEnvironment } from "./contracts.js";

export interface BrokerTax {
  name?: string;
  quantity?: number;
  currency?: string;
  chargedAt?: string;
}

export interface BrokerFill {
  id?: number | string;
  filledAt?: string;
  price?: number;
  quantity?: number;
  type?: string;
  tradingMethod?: string;
  walletImpact?: {
    currency?: string;
    fxRate?: number;
    netValue?: number;
    realisedProfitLoss?: number;
    taxes?: BrokerTax[];
  };
}

export interface BrokerHistoricalOrder {
  id?: number | string;
  ticker?: string;
  side?: string;
  type?: string;
  status?: string;
  quantity?: number;
  filledQuantity?: number;
  value?: number;
  filledValue?: number;
  limitPrice?: number;
  stopPrice?: number;
  currency?: string;
  createdAt?: string;
  initiatedFrom?: string;
  instrument?: { ticker?: string; name?: string; currency?: string; isin?: string };
}

export interface HistoryOrderItem {
  order?: BrokerHistoricalOrder;
  fill?: BrokerFill;
}

export interface HistoryDividendItem {
  reference?: string;
  ticker?: string;
  type?: string;
  amount?: number;
  amountInEuro?: number;
  currency?: string;
  tickerCurrency?: string;
  grossAmountPerShare?: number;
  quantity?: number;
  paidOn?: string;
  instrument?: { ticker?: string; name?: string };
}

export interface HistoryTransactionItem {
  reference?: string;
  type?: string;
  amount?: number;
  currency?: string;
  dateTime?: string;
}

export interface Page<T> {
  items: T[];
  nextPagePath?: string | null;
}

export type TimeEventType =
  | "OPEN" | "CLOSE" | "BREAK_START" | "BREAK_END"
  | "PRE_MARKET_OPEN" | "AFTER_HOURS_OPEN" | "AFTER_HOURS_CLOSE" | "OVERNIGHT_OPEN";

export interface TimeEvent { date: string; type: TimeEventType | string }
export interface WorkingSchedule { id: number; timeEvents: TimeEvent[] }
export interface Exchange { id: number; name: string; workingSchedules: WorkingSchedule[] }

export interface ExportReport {
  reportId: number;
  status?: string;
  downloadLink?: string;
  timeFrom?: string;
  timeTo?: string;
  dataIncluded?: Record<string, boolean>;
}

// ---- Analytics payloads ----

export interface HoldingWeight {
  ticker: string;
  name: string;
  currency: string;
  type?: string;
  value: number;
  weight: number;
  unrealizedProfitLoss?: number;
}

export interface AllocationAnalysis {
  kind: "allocation";
  environment: TradingEnvironment;
  accountCurrency: string;
  totalValue: number;
  investedValue: number;
  cash: number;
  /** Cash free to trade now, without cash held for orders or in pies; what a rebalance can spend. */
  availableCash?: number;
  cashWeight: number;
  holdings: HoldingWeight[];
  byCurrency: Array<{ currency: string; value: number; weight: number }>;
  byType: Array<{ type: string; value: number; weight: number }>;
  concentration: {
    largestWeight: number;
    top5Weight: number;
    herfindahl: number;
    effectiveHoldings: number;
  };
  flags: Array<{ code: "SINGLE_HOLDING_OVER_LIMIT" | "TOP5_OVER_LIMIT" | "CASH_HIGH" | "CASH_LOW" | "CURRENCY_CONCENTRATED" | "DRIFT_OVER_THRESHOLD"; message: string }>;
  /** How far the account is from the saved target weights; present when targets are saved. */
  drift?: AllocationDrift;
  timestamp: string;
}

/** Current against target weight, as shares of total account value; drift is current minus target. */
export interface AllocationDriftRow { ticker: string; target: number; current: number; drift: number }

export interface AllocationDrift {
  /** Drift in weight points above which the scheduler notifies. */
  threshold: number;
  /** Largest absolute drift among the targets and cash. */
  maxDrift: number;
  over: boolean;
  /** One row per target, largest drift first. */
  rows: AllocationDriftRow[];
  cash: { target: number; current: number; drift: number };
  /** Holdings without a target, with their current weight; they count toward maxDrift only with sellUntargeted. */
  untargeted: Array<{ ticker: string; current: number }>;
  /** A rebalance to these targets sells the holdings without one. */
  sellUntargeted?: boolean;
  /** When the targets were saved. */
  savedAt: string;
}

export interface MoneyBucket { key: string; amount: number }

export interface PerformanceSummary {
  kind: "performance";
  environment: TradingEnvironment;
  accountCurrency: string;
  period: { from?: string; to: string };
  coverage: { orders: number; dividends: number; transactions: number; truncated: boolean };
  contributions: { deposits: number; withdrawals: number; net: number };
  income: { dividends: number; interest: number };
  costs: { total: number; byType: MoneyBucket[] };
  realizedProfitLoss: number;
  unrealizedProfitLoss?: number;
  currentValue?: number;
  /** Simple gain on net contributions: (currentValue - netContributions) / netContributions. Only for all-time windows. */
  simpleReturn?: number;
  /**
   * Money-weighted annual return (XIRR) on deposits and withdrawals, with today's value as the last flow.
   * Only for all-time windows with complete history and at least a year since the first deposit.
   */
  annualizedReturn?: number;
  /** Date of the first deposit the annual return counts from. */
  annualizedSince?: string;
  trades: { buys: number; sells: number; turnover: number };
  byTicker: Array<{ ticker: string; realizedProfitLoss: number; dividends: number; costs: number }>;
  notes: string[];
  timestamp: string;
}

/** One tax year's sales, income and costs, for preparing a tax return. Not a tax calculation. */
export interface TaxYearSummary {
  kind: "tax_year";
  environment: TradingEnvironment;
  accountCurrency: string;
  /** Calendar year the tax year starts in, and the month-day it starts on ("01-01", or "04-06" in the UK). */
  year: number;
  yearStart: string;
  /** IANA zone the days are counted in. */
  timeZone: string;
  /** First and last day of the tax year, as local dates. */
  firstDay: string;
  lastDay: string;
  /** From the first moment of the tax year to the last; `ended` is false while it is still running. */
  period: { from: string; to: string };
  ended: boolean;
  /** Sales: Trading 212's realised P/L per sale, gains and losses kept apart. */
  disposals: { count: number; proceeds: number; gains: number; losses: number; net: number };
  byTicker: Array<{ ticker: string; disposals: number; proceeds: number; realizedProfitLoss: number }>;
  income: { dividends: number; interest: number };
  costs: { total: number; byType: MoneyBucket[] };
  truncated: boolean;
  notes: string[];
  timestamp: string;
}

export interface IncomeSummary {
  kind: "income";
  environment: TradingEnvironment;
  accountCurrency: string;
  period: { from?: string; to: string };
  total: number;
  dividends: number;
  interest: number;
  byMonth: MoneyBucket[];
  byTicker: MoneyBucket[];
  trailing12Months: number;
  /**
   * Expected dividends over the next 12 months if each holding pays what it paid per share over the
   * last 12 months. Per-share amounts come from the broker's net payments, so they are after
   * withholding tax and already in the account currency.
   */
  forwardAnnual?: { total: number; byTicker: MoneyBucket[]; yieldOnValue: number | null };
  truncated: boolean;
  timestamp: string;
}

export interface MarketStatus {
  ticker: string;
  scheduleId?: number;
  exchange?: string;
  session: "regular" | "pre_market" | "after_hours" | "overnight" | "break" | "closed" | "unknown";
  isOpen: boolean;
  nextOpen?: string;
  nextClose?: string;
  checkedAt: string;
}
