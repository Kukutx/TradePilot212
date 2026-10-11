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
  TaxYearSummary,
} from "../shared/history.js";

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
  // Only today's account value is known, so a window ending earlier has no value to measure a return against.
  const endsNow = Math.abs((input.now ?? new Date()).getTime() - window.to.getTime()) <= 86_400_000;
  if (!window.from && !endsNow) notes.push("simpleReturn and annualizedReturn are omitted for windows that end before today, because only today's account value is available.");
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
    const first = flows.length ? Math.min(...flows.map((flow) => flow.at)) : undefined;
    if (first !== undefined && window.to.getTime() - first >= 365 * 86_400_000) {
      const rate = moneyWeightedReturn([...flows, { at: window.to.getTime(), amount: currentValue! }]);
      if (rate !== undefined) annualized = { rate, since: new Date(first).toISOString() };
    } else if (first !== undefined) {
      notes.push("annualizedReturn needs at least a year of deposits; it is omitted until then.");
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
    notes,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Next-12-month dividends from each holding's trailing-12-month net payment per share. A holding bought
 * during the year has fewer payments than its schedule, so the payments seen are scaled up to the
 * frequency their spacing implies (monthly, quarterly, half-yearly or yearly).
 */
export function forwardDividends(dividends: HistoryDividendItem[], positions: Position[], to: Date): NonNullable<IncomeSummary["forwardAnnual"]> {
  const yearAgo = new Date(to.getTime() - 365 * 86_400_000);
  const payments = new Map<string, Array<{ at: number; perShare: number }>>();
  for (const item of dividends) {
    const ticker = item.ticker ?? item.instrument?.ticker ?? "";
    if (!ticker || !item.quantity || item.quantity <= 0 || !item.amount || !inWindow(item.paidOn, { from: yearAgo, to })) continue;
    payments.set(ticker, [...(payments.get(ticker) ?? []), { at: Date.parse(item.paidOn!), perShare: item.amount / item.quantity }]);
  }
  const perShare = new Map<string, number>();
  for (const [ticker, list] of payments) {
    const sum = list.reduce((total, item) => total + item.perShare, 0);
    const times = list.map((item) => item.at).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = times.slice(1).map((time, index) => (time - times[index]!) / 86_400_000).filter((days) => days > 10).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : undefined;
    const frequency = gap === undefined ? undefined : gap < 45 ? 12 : gap < 135 ? 4 : gap < 270 ? 2 : 1;
    perShare.set(ticker, frequency && list.length < frequency ? sum * frequency / list.length : sum);
  }
  const byTicker: MoneyBucket[] = [];
  let value = 0;
  for (const position of positions) {
    const ticker = position.instrument?.ticker;
    value += positionValue(position);
    const rate = ticker ? perShare.get(ticker) : undefined;
    if (rate && position.quantity > 0) byTicker.push({ key: ticker!, amount: round(rate * position.quantity) });
  }
  byTicker.sort((a, b) => b.amount - a.amount);
  const total = round(byTicker.reduce((sum, item) => sum + item.amount, 0));
  return { total, byTicker, yieldOnValue: value > 0 ? Math.round((total / value) * 10_000) / 10_000 : null };
}

export function summarizeIncome(input: {
  environment: TradingEnvironment;
  accountCurrency: string;
  dividends: HistoryDividendItem[];
  transactions: HistoryTransactionItem[];
  window: HistoryWindow;
  truncated: boolean;
  positions?: Position[];
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
    ...(input.positions ? { forwardAnnual: forwardDividends(input.dividends, input.positions, input.window.to) } : {}),
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

/** The tax year that starts in `year`, as a window from its first to its last millisecond (UTC). */
export function taxYearWindow(year: number, start: { month: number; day: number }): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(year, start.month - 1, start.day)), to: new Date(Date.UTC(year + 1, start.month - 1, start.day) - 1) };
}

/** The latest tax year that has started by `now`. */
export function currentTaxYear(start: { month: number; day: number }, now = new Date()): number {
  const year = now.getUTCFullYear();
  return now.getTime() >= Date.UTC(year, start.month - 1, start.day) ? year : year - 1;
}

export function summarizeTaxYear(input: {
  environment: TradingEnvironment;
  accountCurrency: string;
  orders: HistoryOrderItem[];
  dividends: HistoryDividendItem[];
  transactions: HistoryTransactionItem[];
  year: number;
  yearStart: { month: number; day: number; text: string };
  truncated: boolean;
  now?: Date;
}): TaxYearSummary {
  const now = input.now ?? new Date();
  const window = taxYearWindow(input.year, input.yearStart);
  const fills = input.orders.filter((item) => item.fill && inWindow(item.fill.filledAt ?? item.order?.createdAt, window));
  let count = 0, proceeds = 0, gains = 0, losses = 0;
  const perTicker = new Map<string, { disposals: number; proceeds: number; realizedProfitLoss: number }>();
  const costs: Array<{ key: string; amount: number }> = [];
  for (const item of fills) {
    const wallet = item.fill?.walletImpact;
    for (const tax of wallet?.taxes ?? []) costs.push({ key: tax.name ?? "OTHER", amount: Math.abs(tax.quantity ?? 0) });
    const quantity = item.fill?.quantity ?? item.order?.filledQuantity ?? 0;
    if ((item.order?.side ?? "").toUpperCase() !== "SELL" && quantity >= 0) continue;
    const pnl = wallet?.realisedProfitLoss ?? 0;
    const value = Math.abs(wallet?.netValue ?? (item.fill?.price ?? 0) * quantity);
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
  if (input.truncated) notes.push("History was truncated at the page limit; older records of this tax year may be missing. Rerun with a larger maxPages.");
  return {
    kind: "tax_year",
    environment: input.environment,
    accountCurrency: input.accountCurrency,
    year: input.year,
    yearStart: input.yearStart.text,
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
