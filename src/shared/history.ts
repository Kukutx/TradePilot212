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
  flags: Array<{ code: "SINGLE_HOLDING_OVER_LIMIT" | "TOP5_OVER_LIMIT" | "CASH_HIGH" | "CASH_LOW" | "CURRENCY_CONCENTRATED"; message: string }>;
  timestamp: string;
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
  trades: { buys: number; sells: number; turnover: number };
  byTicker: Array<{ ticker: string; realizedProfitLoss: number; dividends: number; costs: number }>;
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
