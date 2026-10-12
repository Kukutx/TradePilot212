// Deterministic portfolio analytics. Pure functions only: no I/O, no clock unless passed in.
// The model should call tools backed by these instead of doing arithmetic itself.

import type { AccountSummary, Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type {
  AllocationAnalysis,
  Exchange,
  HistoryDividendItem,
  HistoryOrderItem,
  HistoryTransactionItem,
  IncomeSummary,
  MarketStatus,
  MoneyBucket,
  PerformanceSummary,
  ReturnPoint,
  TaxYearSummary,
  TimeWeightedReturn,
  ValuePoint,
} from "../shared/history.js";
import { addMonths, dividendSchedule, expectedPayments, monthStart, scheduleStart, type PaidDividend } from "./dividends.js";

export interface AllocationLimits {
  maxSingleWeight: number;
  maxTop5Weight: number;
  cashHighWeight: number;
  cashLowWeight: number;
  maxCurrencyWeight: number;
}

export const DEFAULT_ALLOCATION_LIMITS: AllocationLimits = {
  maxSingleWeight: 0.2,
  maxTop5Weight: 0.6,
  cashHighWeight: 0.3,
  cashLowWeight: 0.02,
  maxCurrencyWeight: 0.85,
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

function sumBy<T>(items: T[], key: (item: T) => string, amount: (item: T) => number): MoneyBucket[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + amount(item));
  return [...totals].map(([k, v]) => ({ key: k, amount: round(v) })).sort((a, b) => b.amount - a.amount);
}

/** Position value in account currency: prefer the broker's wallet impact, fall back to quantity × price. */
export function positionValue(position: Position): number {
  const wallet = position.walletImpact as { currentValue?: unknown } | undefined;
  if (typeof wallet?.currentValue === "number" && Number.isFinite(wallet.currentValue)) return wallet.currentValue;
  return position.quantity * position.currentPrice;
}

function positionPnl(position: Position): number | undefined {
  const wallet = position.walletImpact as { unrealizedProfitLoss?: unknown } | undefined;
  return typeof wallet?.unrealizedProfitLoss === "number" ? wallet.unrealizedProfitLoss : undefined;
}

export function analyzeAllocation(
  environment: TradingEnvironment,
  account: AccountSummary,
  positions: Position[],
  instruments: Instrument[] = [],
  limits: AllocationLimits = DEFAULT_ALLOCATION_LIMITS,
  now = new Date(),
): AllocationAnalysis {
  const byTicker = new Map(instruments.map((item) => [item.ticker.toUpperCase(), item]));
  // All uninvested money: free cash, cash held for pending orders and cash sitting in pies.
  const cash = Math.max(0, account.cash?.availableToTrade ?? 0) + Math.max(0, account.cash?.reservedForOrders ?? 0) + Math.max(0, account.cash?.inPies ?? 0);
  const holdings = positions
    .map((position) => {
      const ticker = position.instrument?.ticker ?? "";
      const meta = byTicker.get(ticker.toUpperCase());
      const pnl = positionPnl(position);
      const type = meta?.type ?? position.instrument?.type;
      return {
        ticker,
        name: position.instrument?.name ?? meta?.name ?? ticker,
        currency: (position.instrument?.currencyCode ?? (position.instrument as { currency?: string } | undefined)?.currency ?? meta?.currencyCode ?? "?").toUpperCase(),
        ...(type ? { type } : {}),
        value: positionValue(position),
        weight: 0,
        ...(pnl === undefined ? {} : { unrealizedProfitLoss: pnl }),
      };
    })
    .filter((item) => item.value > 0);
  const investedValue = holdings.reduce((sum, item) => sum + item.value, 0);
  const totalValue = investedValue + cash;
  for (const item of holdings) item.weight = ratio(item.value, totalValue);
  holdings.sort((a, b) => b.value - a.value);

  const group = (key: (item: (typeof holdings)[number]) => string) =>
    sumBy(holdings, key, (item) => item.value).map(({ key: k, amount }) => ({ k, value: amount, weight: ratio(amount, totalValue) }));
  // Pence and pounds are one currency. Exposure includes cash, held in the account currency.
  const holdingCurrencies = group((item) => item.currency === "GBX" ? "GBP" : item.currency);
  const accountCurrency = (account.currency ?? "").toUpperCase();
  const exposure = new Map(holdingCurrencies.map((item) => [item.k, item.value]));
  if (cash > 0 && accountCurrency) exposure.set(accountCurrency, (exposure.get(accountCurrency) ?? 0) + cash);
  const byCurrency = [...exposure].map(([currency, value]) => ({ currency, value: round(value), weight: ratio(value, totalValue) })).sort((a, b) => b.value - a.value);
  const byType = group((item) => item.type ?? "UNKNOWN").map(({ k, value, weight }) => ({ type: k, value, weight }));

  // Concentration is measured over invested holdings only, so a large cash balance does not hide it.
  const investedWeights = holdings.map((item) => ratio(item.value, investedValue));
  const herfindahl = investedWeights.reduce((sum, w) => sum + w * w, 0);
  const largestWeight = investedWeights[0] ?? 0;
  const top5Weight = investedWeights.slice(0, 5).reduce((sum, w) => sum + w, 0);
  const cashWeight = ratio(cash, totalValue);

  const flags: AllocationAnalysis["flags"] = [];
  const pct = (value: number) => `${round(value * 100, 1)}%`;
  if (holdings[0] && largestWeight > limits.maxSingleWeight)
    flags.push({ code: "SINGLE_HOLDING_OVER_LIMIT", message: `${holdings[0].ticker} is ${pct(largestWeight)} of invested value (limit ${pct(limits.maxSingleWeight)}).` });
  if (holdings.length > 5 && top5Weight > limits.maxTop5Weight)
    flags.push({ code: "TOP5_OVER_LIMIT", message: `Top 5 holdings are ${pct(top5Weight)} of invested value (limit ${pct(limits.maxTop5Weight)}).` });
  if (totalValue > 0 && cashWeight > limits.cashHighWeight)
    flags.push({ code: "CASH_HIGH", message: `Cash is ${pct(cashWeight)} of the account.` });
  if (totalValue > 0 && holdings.length && cashWeight < limits.cashLowWeight)
    flags.push({ code: "CASH_LOW", message: `Cash is only ${pct(cashWeight)} of the account.` });
  const topCurrency = holdingCurrencies[0];
  if (topCurrency && investedValue > 0 && ratio(topCurrency.value, investedValue) > limits.maxCurrencyWeight)
    flags.push({ code: "CURRENCY_CONCENTRATED", message: `${pct(ratio(topCurrency.value, investedValue))} of invested value is quoted in ${topCurrency.k}.` });

  return {
    kind: "allocation",
    environment,
    accountCurrency: account.currency ?? "",
    totalValue: round(totalValue),
    investedValue: round(investedValue),
    cash: round(cash),
    ...(typeof account.cash?.availableToTrade === "number" ? { availableCash: round(account.cash.availableToTrade) } : {}),
    cashWeight,
    holdings: holdings.map((item) => ({ ...item, value: round(item.value) })),
    byCurrency,
    byType,
    concentration: { largestWeight, top5Weight, herfindahl, effectiveHoldings: herfindahl > 0 ? round(1 / herfindahl, 1) : 0 },
    flags,
    timestamp: now.toISOString(),
  };
}

export interface HistoryWindow { from?: Date; to: Date }

const inWindow = (value: string | undefined, window: HistoryWindow) => {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= window.to.getTime() && (!window.from || time >= window.from.getTime());
};

const DEPOSIT = new Set(["DEPOSIT"]);
const WITHDRAW = new Set(["WITHDRAW", "WITHDRAWAL"]);
const INTEREST = new Set(["INTEREST_ON_FREE_CASH", "LENDING_INTEREST", "INTEREST"]);

function fillTicker(item: HistoryOrderItem): string {
  return item.order?.ticker ?? item.order?.instrument?.ticker ?? "?";
}

const YEAR_MS = 365.25 * 86_400_000;

/**
 * Money-weighted annual return (XIRR): the yearly rate at which the dated cash flows net to zero.
 * Money paid in is negative and money taken out (including today's value) positive. Undefined when
 * the flows do not change sign or no rate between -99.99% and +10,000% fits.
 */
export function moneyWeightedReturn(flows: Array<{ at: number; amount: number }>): number | undefined {
  const usable = flows.filter((flow) => Number.isFinite(flow.at) && Number.isFinite(flow.amount) && flow.amount !== 0);
  if (!usable.some((flow) => flow.amount < 0) || !usable.some((flow) => flow.amount > 0)) return undefined;
  const start = Math.min(...usable.map((flow) => flow.at));
  const value = (rate: number) => usable.reduce((sum, flow) => sum + flow.amount / (1 + rate) ** ((flow.at - start) / YEAR_MS), 0);
  let low = -0.9999, high = 100;
  let atLow = value(low), atHigh = value(high);
  if (!Number.isFinite(atLow) || !Number.isFinite(atHigh) || Math.sign(atLow) === Math.sign(atHigh)) return undefined;
  for (let step = 0; step < 200 && high - low > 1e-10; step++) {
    const middle = (low + high) / 2;
    const atMiddle = value(middle);
    if (Math.sign(atMiddle) === Math.sign(atLow)) { low = middle; atLow = atMiddle; } else { high = middle; atHigh = atMiddle; }
  }
  return (low + high) / 2;
}

/** Below this much in the account currency, a stretch has nothing invested to measure a return on. */
const MIN_INVESTED = 1;
/** An account holding less than this share of the money moved in or out in a stretch counts as empty. */
const EMPTY_SHARE = 0.01;

/**
 * Time-weighted return over recorded account values. Each stretch between two readings is measured by the
 * Modified Dietz method: the change in value less the deposits and withdrawals in it, over the starting
 * value plus each of those flows weighted by the share of the stretch it was invested for. The stretches are
 * chained, so money paid in or taken out moves the value but not the return. Deposits are positive flows
 * and withdrawals negative. An empty account earns nothing, so a stretch that starts empty is measured from its
 * first deposit, and one that ends empty up to its last withdrawal: a deposit into an empty account an hour
 * before a reading then earns what it gained in that hour, not that gain spread over the hour's share of the
 * day. Undefined with fewer than two readings, or when a stretch began with nothing invested yet still gained
 * or lost.
 */
export function timeWeightedReturn(points: ValuePoint[], flows: Array<{ at: number; amount: number }>): TimeWeightedReturn | undefined {
  const readings = points
    .map((point) => ({ point, at: Date.parse(point.at) }))
    .filter((reading) => Number.isFinite(reading.at) && Number.isFinite(reading.point.totalValue))
    .sort((a, b) => a.at - b.at);
  if (readings.length < 2) return undefined;
  const series: ReturnPoint[] = [{ date: readings[0]!.point.date, return: 0 }];
  let growth = 1, netFlows = 0;
  for (let index = 1; index < readings.length; index++) {
    const start = readings[index - 1]!, end = readings[index]!;
    const inside = flows.filter((flow) => Number.isFinite(flow.amount) && flow.at > start.at && flow.at <= end.at);
    const total = inside.reduce((sum, flow) => sum + flow.amount, 0);
    // The part of the stretch anything was invested in: from the first deposit into an empty account, up to the
    // withdrawal that emptied it.
    const empty = (value: number) => value < Math.max(MIN_INVESTED, EMPTY_SHARE * inside.reduce((sum, flow) => sum + Math.abs(flow.amount), 0));
    const deposits = inside.filter((flow) => flow.amount > 0).map((flow) => flow.at);
    const withdrawals = inside.filter((flow) => flow.amount < 0).map((flow) => flow.at);
    const from = empty(start.point.totalValue) && deposits.length ? Math.min(...deposits) : start.at;
    const to = empty(end.point.totalValue) && withdrawals.length ? Math.max(...withdrawals) : end.at;
    const length = to - from;
    const share = (at: number) => length > 0 ? Math.min(1, Math.max(0, (to - at) / length)) : 1;
    const weighted = inside.reduce((sum, flow) => sum + flow.amount * share(flow.at), 0);
    const invested = start.point.totalValue + weighted;
    const gain = end.point.totalValue - start.point.totalValue - total;
    netFlows += total;
    if (invested < MIN_INVESTED) {
      // An empty account that stayed empty has no return to chain; one that moved cannot be measured.
      if (Math.abs(gain) >= MIN_INVESTED) return undefined;
    } else {
      growth *= 1 + gain / invested;
    }
    if (!(growth > 0)) return undefined;
    series.push({ date: end.point.date, return: round(growth - 1, 6) });
  }
  return { return: round(growth - 1, 6), from: readings[0]!.point.date, to: readings[readings.length - 1]!.point.date, netFlows: round(netFlows), series };
}

export function summarizePerformance(input: {
  environment: TradingEnvironment;
  account: AccountSummary;
  orders: HistoryOrderItem[];
  dividends: HistoryDividendItem[];
  transactions: HistoryTransactionItem[];
  window: HistoryWindow;
  truncated: boolean;
  /** When the account value was read; returns need a window that ends then. */
  now?: Date;
  /** The account value TradePilot recorded each day in the window: the value chart and the time-weighted return. */
  values?: ValuePoint[];
  /** Whether the transactions stopped at the page limit; `truncated` covers every data set. */
  transactionsTruncated?: boolean;
}): PerformanceSummary {
  const { window } = input;
  const fills = input.orders.filter((item) => item.fill && inWindow(item.fill.filledAt ?? item.order?.createdAt, window));
  const dividends = input.dividends.filter((item) => inWindow(item.paidOn, window));
  const transactions = input.transactions.filter((item) => inWindow(item.dateTime, window));

  let deposits = 0, withdrawals = 0, interest = 0;
  const transactionCosts: Array<{ key: string; amount: number }> = [];
  for (const item of transactions) {
    const amount = item.amount ?? 0;
    const type = (item.type ?? "").toUpperCase();
    if (DEPOSIT.has(type)) deposits += Math.abs(amount);
    else if (WITHDRAW.has(type)) withdrawals += Math.abs(amount);
    else if (INTEREST.has(type)) interest += amount;
    else if (type === "FEE") transactionCosts.push({ key: "ACCOUNT_FEE", amount: Math.abs(amount) });
  }

  const taxes: Array<{ key: string; amount: number; ticker: string }> = [];
  const perTicker = new Map<string, { realizedProfitLoss: number; dividends: number; costs: number }>();
  const tickerRow = (ticker: string) => {
    let row = perTicker.get(ticker);
    if (!row) perTicker.set(ticker, (row = { realizedProfitLoss: 0, dividends: 0, costs: 0 }));
    return row;
  };
  let realized = 0, buys = 0, sells = 0, turnover = 0;
  for (const item of fills) {
    const ticker = fillTicker(item);
    const wallet = item.fill?.walletImpact;
    const pnl = wallet?.realisedProfitLoss ?? 0;
    realized += pnl;
    tickerRow(ticker).realizedProfitLoss += pnl;
    turnover += Math.abs(wallet?.netValue ?? (item.fill?.price ?? 0) * (item.fill?.quantity ?? 0));
    const side = (item.order?.side ?? "").toUpperCase();
    const quantity = item.fill?.quantity ?? item.order?.filledQuantity ?? 0;
    if (side === "SELL" || quantity < 0) sells++; else buys++;
    for (const tax of wallet?.taxes ?? []) {
      const amount = Math.abs(tax.quantity ?? 0);
      taxes.push({ key: tax.name ?? "OTHER", amount, ticker });
      tickerRow(ticker).costs += amount;
    }
  }

  let dividendTotal = 0;
  for (const item of dividends) {
    const amount = item.amount ?? 0;
    dividendTotal += amount;
    tickerRow(item.ticker ?? item.instrument?.ticker ?? "?").dividends += amount;
  }

  const costs = [...taxes, ...transactionCosts];
  const costTotal = costs.reduce((sum, item) => sum + item.amount, 0);
  const net = deposits - withdrawals;
  const currentValue = input.account.totalValue;
  const notes = [
    "Amounts are in the account currency as reported by Trading 212.",
    "Realized P/L comes from the broker's per-fill wallet impact and already reflects FX at execution.",
  ];
  if (input.truncated) notes.push("History was truncated at the page limit; totals cover only the most recent records.");
  if (window.from) notes.push("simpleReturn is omitted for bounded periods because the starting value is not available from the API.");
  // Only the account value at `now` is known, so the window must reach it: one that ends earlier would
  // leave out deposits and withdrawals the value already reflects. A few minutes cover reading the history.
  const endsNow = window.to.getTime() >= (input.now ?? new Date()).getTime() - 5 * 60_000;
  if (!window.from && !endsNow) notes.push("simpleReturn and annualizedReturn are omitted for windows that end before now, because only the current account value is available.");
  const measurable = !window.from && endsNow && !input.truncated && currentValue !== undefined;

  // The annual return weighs each deposit and withdrawal by how long it was invested. It needs the
  // whole history, and a year of it, so a few weeks of luck are not annualised into a headline number.
  let annualized: { rate: number; since: string } | undefined;
  if (measurable) {
    const flows = transactions.flatMap((item) => {
      const type = (item.type ?? "").toUpperCase();
      const at = Date.parse(item.dateTime ?? "");
      const amount = Math.abs(item.amount ?? 0);
      return DEPOSIT.has(type) ? [{ at, amount: -amount }] : WITHDRAW.has(type) ? [{ at, amount }] : [];
    }).filter((flow) => Number.isFinite(flow.at));
    // The year is counted from the first deposit; an earlier withdrawal (after a transfer in) still counts as a flow.
    const deposits = flows.filter((flow) => flow.amount < 0);
    const first = deposits.length ? Math.min(...deposits.map((flow) => flow.at)) : undefined;
    if (first !== undefined && window.to.getTime() - first >= 365 * 86_400_000) {
      const rate = moneyWeightedReturn([...flows, { at: window.to.getTime(), amount: currentValue! }]);
      if (rate !== undefined) annualized = { rate, since: new Date(first).toISOString() };
    } else if (first !== undefined) {
      notes.push("annualizedReturn needs at least a year of deposits; it is omitted until then.");
    }
  }

  // The time-weighted return needs every deposit and withdrawal between the first reading and the last.
  // History is read newest first, so after a cut-off it is complete back to the oldest record read.
  let timeWeighted: TimeWeightedReturn | undefined;
  if (input.values && input.values.length >= 2) {
    const firstReading = Math.min(...input.values.map((point) => Date.parse(point.at)).filter(Number.isFinite));
    const oldestRead = Math.min(...input.transactions.map((item) => Date.parse(item.dateTime ?? "")).filter(Number.isFinite));
    if ((input.transactionsTruncated ?? input.truncated) && !(oldestRead <= firstReading)) {
      notes.push("timeWeighted is omitted because the deposit and withdrawal history stops before the first recorded day; raise maxPages.");
    } else {
      // A transfer between Trading 212 accounts moves money in or out like a deposit or withdrawal; its sign says which.
      const flows = transactions.flatMap((item) => {
        const type = (item.type ?? "").toUpperCase();
        const at = Date.parse(item.dateTime ?? "");
        const amount = Math.abs(item.amount ?? 0);
        if (!Number.isFinite(at)) return [];
        return DEPOSIT.has(type) ? [{ at, amount }] : WITHDRAW.has(type) ? [{ at, amount: -amount }] : type === "TRANSFER" && item.amount ? [{ at, amount: item.amount }] : [];
      });
      timeWeighted = timeWeightedReturn(input.values, flows);
      if (!timeWeighted) notes.push("timeWeighted is omitted because a stretch between recorded days began with nothing invested.");
    }
  }

  return {
    kind: "performance",
    environment: input.environment,
    accountCurrency: input.account.currency ?? "",
    period: { ...(window.from ? { from: window.from.toISOString() } : {}), to: window.to.toISOString() },
    coverage: { orders: fills.length, dividends: dividends.length, transactions: transactions.length, truncated: input.truncated },
    contributions: { deposits: round(deposits), withdrawals: round(withdrawals), net: round(net) },
    income: { dividends: round(dividendTotal), interest: round(interest) },
    costs: { total: round(costTotal), byType: sumBy(costs, (item) => item.key, (item) => item.amount) },
    realizedProfitLoss: round(realized),
    ...(input.account.investments?.unrealizedProfitLoss === undefined ? {} : { unrealizedProfitLoss: input.account.investments.unrealizedProfitLoss }),
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(measurable && net > 0 ? { simpleReturn: (currentValue! - net) / net } : {}),
    ...(annualized ? { annualizedReturn: Math.round(annualized.rate * 10_000) / 10_000, annualizedSince: annualized.since } : {}),
    trades: { buys, sells, turnover: round(turnover) },
    byTicker: [...perTicker]
      .map(([ticker, row]) => ({ ticker, realizedProfitLoss: round(row.realizedProfitLoss), dividends: round(row.dividends), costs: round(row.costs) }))
      .sort((a, b) => Math.abs(b.realizedProfitLoss) + b.dividends - (Math.abs(a.realizedProfitLoss) + a.dividends)),
    ...(input.values && input.values.length >= 2 ? { valueHistory: input.values } : {}),
    ...(timeWeighted ? { timeWeighted } : {}),
    notes,
    timestamp: new Date().toISOString(),
  };
}

/** Each instrument's payments per share from `from` to `to`, for its dividend schedule. */
function paidPerShare(dividends: HistoryDividendItem[], from: number, to: Date): Map<string, PaidDividend[]> {
  const read = { from: new Date(from), to };
  const payments = new Map<string, PaidDividend[]>();
  for (const item of dividends) {
    const ticker = item.ticker ?? item.instrument?.ticker ?? "";
    if (!ticker || !item.quantity || item.quantity <= 0 || !item.amount || !inWindow(item.paidOn, read)) continue;
    payments.set(ticker, [...(payments.get(ticker) ?? []), { at: Date.parse(item.paidOn!), perShare: item.amount / item.quantity, amount: item.amount, quantity: item.quantity }]);
  }
  return payments;
}

/**
 * The payments the holdings are expected to make from `from` until before `until`, soonest first, on the schedules the
 * dividend calendar uses (read up to `to`): one due since `from` and not paid yet is still expected. The schedules are
 * read from the first day of `from`'s month a year before, so a yearly payment due then is still seen.
 */
export function expectedDividends(dividends: HistoryDividendItem[], positions: Position[], from: number, until: number, to: Date): Array<{ ticker: string; on: string; amount: number }> {
  const payments = paidPerShare(dividends, Math.min(scheduleStart(from), scheduleStart(to.getTime())), to);
  const expected: Array<{ ticker: string; at: number; amount: number }> = [];
  for (const position of positions) {
    const ticker = position.instrument?.ticker;
    const schedule = ticker ? dividendSchedule(payments.get(ticker) ?? []) : undefined;
    if (!ticker || !schedule || !(position.quantity > 0)) continue;
    expected.push(...expectedPayments(schedule, position.quantity, from, until).map((payment) => ({ ticker, ...payment })));
  }
  return expected.sort((a, b) => a.at - b.at || b.amount - a.amount).map(({ ticker, at, amount }) => ({ ticker, on: new Date(at).toISOString().slice(0, 10), amount }));
}

/**
 * Next-12-month dividends from each holding's net payments per share over the last year (from the first day of this
 * month a year ago), at the current quantity. A holding bought during the year has fewer paydays than its schedule,
 * so they are scaled up to the frequency their spacing implies (weekly to yearly). While `to` is in the current
 * month, the calendar spreads them over this month and the next 11 by that spacing, beside what was paid so far
 * this month; for a period ending in another month there is no calendar.
 */
export function forwardDividends(dividends: HistoryDividendItem[], positions: Position[], to: Date, now: Date = to): NonNullable<IncomeSummary["forwardAnnual"]> {
  const payments = paidPerShare(dividends, scheduleStart(to.getTime()), to);
  const start = monthStart(to.getTime());
  const end = addMonths(start, 12);
  const current = start === monthStart(now.getTime());
  const byTicker: MoneyBucket[] = [];
  const upcoming: Array<{ ticker: string; at: number; amount: number }> = [];
  let value = 0;
  for (const position of positions) {
    const ticker = position.instrument?.ticker;
    value += positionValue(position);
    const schedule = ticker ? dividendSchedule(payments.get(ticker) ?? []) : undefined;
    if (!ticker || !schedule || !(position.quantity > 0)) continue;
    byTicker.push({ key: ticker, amount: round(schedule.annualPerShare * position.quantity) });
    if (current) upcoming.push(...expectedPayments(schedule, position.quantity, start, end).map((payment) => ({ ticker, ...payment })));
  }
  byTicker.sort((a, b) => b.amount - a.amount);
  upcoming.sort((a, b) => a.at - b.at || b.amount - a.amount);
  const total = round(byTicker.reduce((sum, item) => sum + item.amount, 0));
  const forward = { total, byTicker, yieldOnValue: value > 0 ? Math.round((total / value) * 10_000) / 10_000 : null };
  if (!current) return forward;
  const monthKey = (at: number) => new Date(at).toISOString().slice(0, 7);
  const paid = dividends.filter((item) => inWindow(item.paidOn, { from: new Date(start), to })).reduce((sum, item) => sum + (item.amount ?? 0), 0);
  const calendar = Array.from({ length: 12 }, (_, index) => {
    const month = monthKey(addMonths(start, index));
    const expected = upcoming.filter((payment) => monthKey(payment.at) === month).reduce((sum, payment) => sum + payment.amount, 0);
    return { month, paid: index === 0 ? round(paid) : 0, expected: round(expected) };
  });
  return {
    ...forward,
    calendar,
    upcoming: upcoming.map(({ ticker, at, amount }) => ({ ticker, on: new Date(at).toISOString().slice(0, 10), amount })),
  };
}

export function summarizeIncome(input: {
  environment: TradingEnvironment;
  accountCurrency: string;
  dividends: HistoryDividendItem[];
  transactions: HistoryTransactionItem[];
  window: HistoryWindow;
  truncated: boolean;
  positions?: Position[];
  /** The clock, for whether the period ends this month and so has a dividend calendar. */
  now?: Date;
}): IncomeSummary {
  const events = [
    ...input.dividends.map((item) => ({ at: item.paidOn, amount: item.amount ?? 0, ticker: item.ticker ?? item.instrument?.ticker ?? "?", dividend: true })),
    ...input.transactions
      .filter((item) => INTEREST.has((item.type ?? "").toUpperCase()))
      .map((item) => ({ at: item.dateTime, amount: item.amount ?? 0, ticker: "INTEREST", dividend: false })),
  ];
  const windowed = events.filter((item) => inWindow(item.at, input.window));
  const yearAgo = new Date(input.window.to.getTime() - 365 * 86_400_000);
  const trailing = events.filter((item) => inWindow(item.at, { from: yearAgo, to: input.window.to }));
  const dividends = windowed.filter((item) => item.dividend).reduce((sum, item) => sum + item.amount, 0);
  const interest = windowed.filter((item) => !item.dividend).reduce((sum, item) => sum + item.amount, 0);
  return {
    kind: "income",
    environment: input.environment,
    accountCurrency: input.accountCurrency,
    period: { ...(input.window.from ? { from: input.window.from.toISOString() } : {}), to: input.window.to.toISOString() },
    total: round(dividends + interest),
    dividends: round(dividends),
    interest: round(interest),
    byMonth: sumBy(windowed, (item) => (item.at ?? "").slice(0, 7), (item) => item.amount).sort((a, b) => a.key.localeCompare(b.key)),
    byTicker: sumBy(windowed.filter((item) => item.dividend), (item) => item.ticker, (item) => item.amount),
    trailing12Months: round(trailing.reduce((sum, item) => sum + item.amount, 0)),
    ...(input.positions ? { forwardAnnual: forwardDividends(input.dividends, input.positions, input.window.to, input.now ?? input.window.to) } : {}),
    truncated: input.truncated,
    timestamp: new Date().toISOString(),
  };
}

const SESSION_BY_EVENT: Record<string, MarketStatus["session"]> = {
  OPEN: "regular",
  BREAK_END: "regular",
  BREAK_START: "break",
  PRE_MARKET_OPEN: "pre_market",
  AFTER_HOURS_OPEN: "after_hours",
  OVERNIGHT_OPEN: "overnight",
  CLOSE: "closed",
  AFTER_HOURS_CLOSE: "closed",
};

/** Derive the current session for an instrument from the broker's working-schedule events. */
export function marketStatus(instrument: Instrument & { workingScheduleId?: number }, exchanges: Exchange[], now = new Date()): MarketStatus {
  const checkedAt = now.toISOString();
  const scheduleId = instrument.workingScheduleId;
  const exchange = exchanges.find((item) => item.workingSchedules?.some((schedule) => schedule.id === scheduleId));
  const schedule = exchange?.workingSchedules.find((item) => item.id === scheduleId);
  if (scheduleId === undefined || !schedule?.timeEvents?.length)
    return { ticker: instrument.ticker, ...(scheduleId === undefined ? {} : { scheduleId }), session: "unknown", isOpen: false, checkedAt };

  const events = schedule.timeEvents
    .map((event) => ({ ...event, time: Date.parse(event.date) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const nowTime = now.getTime();
  const past = events.filter((event) => event.time <= nowTime);
  const future = events.filter((event) => event.time > nowTime);
  const last = past[past.length - 1];
  const session = last ? SESSION_BY_EVENT[last.type] ?? "unknown" : "closed";
  const nextOpen = future.find((event) => event.type === "OPEN");
  const nextClose = future.find((event) => event.type === "CLOSE");
  return {
    ticker: instrument.ticker,
    scheduleId,
    ...(exchange ? { exchange: exchange.name } : {}),
    session,
    isOpen: session === "regular",
    ...(nextOpen ? { nextOpen: new Date(nextOpen.time).toISOString() } : {}),
    ...(nextClose ? { nextClose: new Date(nextClose.time).toISOString() } : {}),
    checkedAt,
  };
}

/** "MM-DD" → month and day; the default is the calendar year. */
export function parseYearStart(value: string | undefined): { month: number; day: number; text: string } {
  const match = /^(\d{2})-(\d{2})$/.exec(value?.trim() ?? "01-01");
  const month = Number(match?.[1]), day = Number(match?.[2]);
  const valid = match && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(2001, month, 0)).getUTCDate();
  return valid ? { month, day, text: `${match[1]}-${match[2]}` } : { month: 1, day: 1, text: "01-01" };
}

/** Whether `timeZone` is an IANA zone this runtime knows, such as Europe/London. */
export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds that local time in `timeZone` is ahead of UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(instant / 1000) * 1000;
}

/** The local calendar date of an instant in `timeZone`, as YYYY-MM-DD. */
function localDay(instant: number, timeZone: string): string {
  return new Date(instant + zoneOffset(instant, timeZone)).toISOString().slice(0, 10);
}

/** The instant a local calendar day starts in `timeZone`. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffset(guess, timeZone);
  // A second pass settles days where the offset changes between the guess and local midnight.
  return guess - zoneOffset(first, timeZone);
}

/** The tax year that starts in `year`, from its first to its last millisecond in `timeZone` (UTC by default). */
export function taxYearWindow(year: number, start: { month: number; day: number }, timeZone = "UTC"): { from: Date; to: Date } {
  return { from: new Date(localMidnight(year, start.month, start.day, timeZone)), to: new Date(localMidnight(year + 1, start.month, start.day, timeZone) - 1) };
}

/** The latest tax year that has started by `now` in `timeZone`. */
export function currentTaxYear(start: { month: number; day: number }, now = new Date(), timeZone = "UTC"): number {
  const year = new Date(now.getTime() + zoneOffset(now.getTime(), timeZone)).getUTCFullYear();
  return now.getTime() >= localMidnight(year, start.month, start.day, timeZone) ? year : year - 1;
}

export function summarizeTaxYear(input: {
  environment: TradingEnvironment;
  accountCurrency: string;
  orders: HistoryOrderItem[];
  dividends: HistoryDividendItem[];
  transactions: HistoryTransactionItem[];
  year: number;
  yearStart: { month: number; day: number; text: string };
  /** IANA zone the tax year's days are counted in; UTC by default. */
  timeZone?: string;
  truncated: boolean;
  now?: Date;
}): TaxYearSummary {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? "UTC";
  const window = taxYearWindow(input.year, input.yearStart, timeZone);
  // A sale belongs to the year it filled in; the order's creation date could fall in an earlier year.
  const fills = input.orders.filter((item) => item.fill && inWindow(item.fill.filledAt, window));
  const undated = input.orders.filter((item) => item.fill && !Number.isFinite(Date.parse(item.fill.filledAt ?? ""))).length;
  let count = 0, proceeds = 0, gains = 0, losses = 0, unvalued = 0;
  const perTicker = new Map<string, { disposals: number; proceeds: number; realizedProfitLoss: number }>();
  const costs: Array<{ key: string; amount: number }> = [];
  for (const item of fills) {
    const wallet = item.fill?.walletImpact;
    for (const tax of wallet?.taxes ?? []) costs.push({ key: tax.name ?? "OTHER", amount: Math.abs(tax.quantity ?? 0) });
    const quantity = item.fill?.quantity ?? item.order?.filledQuantity ?? 0;
    if ((item.order?.side ?? "").toUpperCase() !== "SELL" && quantity >= 0) continue;
    const pnl = wallet?.realisedProfitLoss ?? 0;
    // Only Trading 212's account-currency value counts; price × quantity would be in the instrument's currency.
    const value = wallet?.netValue === undefined ? 0 : Math.abs(wallet.netValue);
    if (wallet?.netValue === undefined) unvalued++;
    count++;
    proceeds += value;
    if (pnl > 0) gains += pnl; else losses += pnl;
    const ticker = fillTicker(item);
    const row = perTicker.get(ticker) ?? { disposals: 0, proceeds: 0, realizedProfitLoss: 0 };
    row.disposals++;
    row.proceeds += value;
    row.realizedProfitLoss += pnl;
    perTicker.set(ticker, row);
  }
  let dividends = 0, interest = 0;
  for (const item of input.dividends) if (inWindow(item.paidOn, window)) dividends += item.amount ?? 0;
  for (const item of input.transactions) {
    if (!inWindow(item.dateTime, window)) continue;
    const type = (item.type ?? "").toUpperCase();
    if (INTEREST.has(type)) interest += item.amount ?? 0;
    else if (type === "FEE") costs.push({ key: "ACCOUNT_FEE", amount: Math.abs(item.amount ?? 0) });
  }
  const ended = now.getTime() > window.to.getTime();
  const notes = [
    "Amounts are in the account currency as reported by Trading 212.",
    "Gains and losses are Trading 212's realised P/L per sale, worked out against your average purchase price at the exchange rate of the sale. Countries match purchases to sales in their own way (for example the UK's same-day and 30-day rules), so use these figures to prepare and check a return, not as the tax due.",
    "Dividends are the amounts paid into the account, after any tax withheld at source. The Trading 212 annual statement and CSV export (manage_history_export) give the detail a return may need.",
  ];
  if (!ended) notes.push("This tax year is still running; the figures cover it up to now.");
  if (timeZone === "UTC") notes.push("Days are counted in UTC. Pass timeZone (for example Europe/London) so trades just after local midnight fall in the right year.");
  if (unvalued) notes.push(`${unvalued} sale(s) had no account-currency value from Trading 212; proceeds leave them out, but their realised P/L is counted.`);
  if (undated) notes.push(`${undated} fill(s) had no fill date and are left out; check them in the Trading 212 statement.`);
  if (input.truncated) notes.push("History was truncated at the page limit; older records of this tax year may be missing. Rerun with a larger maxPages.");
  return {
    kind: "tax_year",
    environment: input.environment,
    accountCurrency: input.accountCurrency,
    year: input.year,
    yearStart: input.yearStart.text,
    timeZone,
    firstDay: `${input.year}-${input.yearStart.text}`,
    lastDay: localDay(window.to.getTime(), timeZone),
    period: { from: window.from.toISOString(), to: window.to.toISOString() },
    ended,
    disposals: { count, proceeds: round(proceeds), gains: round(gains), losses: round(losses), net: round(gains + losses) },
    byTicker: [...perTicker].map(([ticker, row]) => ({ ticker, disposals: row.disposals, proceeds: round(row.proceeds), realizedProfitLoss: round(row.realizedProfitLoss) }))
      .sort((a, b) => Math.abs(b.realizedProfitLoss) - Math.abs(a.realizedProfitLoss)),
    income: { dividends: round(dividends), interest: round(interest) },
    costs: { total: round(costs.reduce((sum, item) => sum + item.amount, 0)), byType: sumBy(costs, (item) => item.key, (item) => item.amount) },
    truncated: input.truncated,
    notes,
    timestamp: now.toISOString(),
  };
}
