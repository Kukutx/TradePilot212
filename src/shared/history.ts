// Trading 212 history, schedule, and report shapes, plus the analytics payloads built from them.
// Broker fields are optional because the Public API is still marked Beta and omits empty values.

import type { TradingEnvironment } from "./contracts.js";
import type { PricesMissing } from "./prices.js";

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

/** The account's total value on one UTC day, as TradePilot last saw it that day. */
export interface ValuePoint {
  date: string;
  totalValue: number;
  /** Cash available to trade. */
  cash?: number;
  /** Value of the holdings. */
  invested?: number;
  /** When the value was read. */
  at: string;
}

/** The chained time-weighted return from the first recorded day up to one day. */
export interface ReturnPoint {
  date: string;
  return: number;
}

/** A calendar month's or year's time-weighted return, chained from the last recorded day before it to its last recorded day. */
export interface CalendarReturn {
  /** "2026-05" for a month, "2026" for a year. */
  period: string;
  return: number;
  /** The recorded days it runs from and to. */
  from: string;
  to: string;
  /** Only part of it was recorded: the record began inside it, or it ends before its last day or before it is over. */
  partial?: true;
  /** It starts from a recorded day before the end of the period before it, with none in between, so its return takes
   * in those days too. */
  extended?: true;
}

/** The deepest fall of a return from a high, and how far below its high it ends (`src/shared/drawdown.ts`). */
export interface Drawdown {
  /** The deepest fall from a high, as a negative fraction (-0.082 is 8.2% below it); 0 when it never fell by 0.05% or more. */
  max: number;
  /** The day of the high it fell from and of the low it fell to; absent when it never fell. */
  peak?: string;
  trough?: string;
  /** The first day after the low back at the high it fell from; absent while it has not been made up. */
  recovered?: string;
  /** How far below the highest point so far it is on the last day, as a negative fraction: 0 at (or within 0.05% of) a high. */
  current: number;
  /** The day of that high, when it is below it. */
  currentPeak?: string;
}

/** One day's move: the return from the reading the day before to that day's. */
export interface DailyMove {
  date: string;
  return: number;
}

/** The time-weighted return's day-to-day risk (`src/shared/risk.ts`). */
export interface Risk {
  /** The first and last day it is read over: stretches that end today are left out, as the day is not over. */
  from: string;
  to: string;
  /** Stretches between readings it is read over (a reading at the weekend joins the next), and the weekdays they cover. */
  stretches: number;
  days: number;
  /** The standard deviation of the moves, per weekday, times √261: a year's worth. */
  volatility: number;
  /** One-weekday stretches that rose, and that fell, by 0.005% or more; ones that moved less (holidays) are in neither. */
  up: number;
  down: number;
  /** The largest rise and fall of a one-weekday stretch. */
  best?: DailyMove;
  worst?: DailyMove;
  /** The return a year at the rate over these days, from a year of them, and it over the volatility (from 0.5% a year). */
  annualized?: number;
  ratio?: number;
}
export interface BenchmarkRisk {
  volatility: number;
  /** How much the return moved for each 1% the benchmark moved, over the benchmark's day before, the same day and the day after. */
  beta: number;
  /** -1 to 1: how closely the two moved together, over the same days. */
  correlation: number;
}

/**
 * Return over the days TradePilot recorded the account value, with deposits and withdrawals taken out:
 * how the money that was invested did, whatever was paid in or taken out along the way.
 */
export interface TimeWeightedReturn {
  /** From the first recorded day to the last, as a fraction (0.042 is +4.2%). */
  return: number;
  /** Dates of the first and last recorded day. */
  from: string;
  to: string;
  /** Deposits and transfers in, less withdrawals and transfers out, between them: what the return leaves out. */
  netFlows: number;
  series: ReturnPoint[];
  /** Its deepest fall from a high over those days. */
  drawdown?: Drawdown;
  /** Its return in each calendar month and year those days touch (UTC dates), oldest first. */
  months?: CalendarReturn[];
  years?: CalendarReturn[];
  /** How much it moved from day to day, from 20 stretches between readings. */
  risk?: Risk;
}

/** An instrument to compare the return with. */
export interface BenchmarkOption {
  ticker: string;
  name?: string;
  shortName?: string;
}

/**
 * A benchmark's price over the days of the time-weighted return, from its close on or before each day: how the
 * same money would have done in it. In the benchmark's own currency, without its dividends unless it accumulates.
 */
export interface BenchmarkReturn extends BenchmarkOption {
  currencyCode?: string;
  /** Where the closes came from: a quote provider, or "sample". */
  source: string;
  symbol?: string;
  /** From the first recorded day to the last, as a fraction. */
  return: number;
  /** On each day of the time-weighted return's series. */
  series: ReturnPoint[];
  /** Its deepest fall from a high over the same days. */
  drawdown?: Drawdown;
  /** Its volatility over the same stretches, and how the return moved with it. */
  risk?: BenchmarkRisk;
}

/** One instrument's gain over a period, in the account currency. */
export interface HoldingGain {
  ticker: string;
  /** Shares at the start (today's, less those bought since, plus those sold since) and now. */
  startQuantity: number;
  quantity: number;
  /** The close the start is valued at, in the instrument's currency and unit, and its day; none when nothing was held. */
  startClose?: { date: string; price: number };
  /** The shares held at the start at that close, at today's exchange rate; 0 when none were held. */
  startValue: number;
  /** Now, as Trading 212 values the holding; 0 once sold. */
  value: number;
  /** What its buys took from the account and its sells paid in (Trading 212's net amounts), and its dividends. */
  bought: number;
  sold: number;
  dividends: number;
  /**
   * value − startValue − bought + sold + dividends; over all history, Trading 212's realised P/L on the sells, its
   * unrealised P/L on what is held and the dividends, which also covers shares bought before the history read.
   */
  gain: number;
  /** The gain on the money at work, startValue + bought; none when that is nothing. */
  return?: number;
}

/** Where a period's gain came from, instrument by instrument. */
export interface GainAttribution {
  /** The first day counted (YYYY-MM-DD): what was held is valued at the close before it. None for all history. */
  from?: string;
  /** "start": the gain from the value at the start; "cost": over all history, from what each holding cost. */
  basis: "start" | "cost";
  to: string;
  /** Largest gain first. */
  holdings: HoldingGain[];
  /** The holdings' gains added up. */
  total: number;
  /**
   * Instruments left out of it: no close before the start (the reason as for the price chart, or "later" when the read
   * ran out of time), shares that do not add up ("quantity": a split, or shares moved in), or no exchange rate ("rate").
   */
  missing: Array<{ ticker: string; reason: PricesMissing | "later" | "quantity" | "rate"; problem: string }>;
}

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
  /** The account value TradePilot recorded each day in the window, when it has two days or more. */
  valueHistory?: ValuePoint[];
  /** The time-weighted return over those days, when every deposit and withdrawal between them was read. */
  timeWeighted?: TimeWeightedReturn;
  /** The benchmark's return over the same days, with the time-weighted return. */
  benchmark?: BenchmarkReturn;
  /** The choice this read used: the instrument compared with or tried, the query that found none, or "none". */
  benchmarkChoice?: string;
  /** Why there is no benchmark beside the time-weighted return ("instrument": Trading 212 matched none, or several). */
  benchmarkMissing?: PricesMissing | "instrument";
  benchmarkProblem?: string;
  /** The instruments it can be compared with: the default, then the ETFs held and on the watchlist. */
  benchmarkOptions?: BenchmarkOption[];
  /** Each instrument's gain over the period; absent with `attributionProblem` when it cannot be worked out. */
  attribution?: GainAttribution;
  attributionProblem?: string;
  /** Why there is none: a period that ends before now, a history cut short at its page limit, or a read that failed. */
  attributionMissing?: "period" | "history" | "data";
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
   * Expected dividends over the next 12 months if each holding pays what it paid per share over its
   * last year of paydays. Per-share amounts come from the broker's net payments, so they are after
   * withholding tax and already in the account currency.
   */
  forwardAnnual?: {
    total: number;
    byTicker: MoneyBucket[];
    yieldOnValue: number | null;
    /**
     * The dividend calendar: this month and the next 11 (keys YYYY-MM), each with what was paid so far and what is
     * expected. Each holding's payments follow its usual spacing from its last payment, at the current quantity.
     * Absent for a period that ends in another month (and from results before 2.38).
     */
    calendar?: Array<{ month: string; paid: number; expected: number }>;
    /** The expected payments in the calendar, soonest first; `on` (YYYY-MM-DD) is about when, and may have passed this month. */
    upcoming?: Array<{ ticker: string; on: string; amount: number }>;
  };
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
