import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import type { Exchange, HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem, ValuePoint } from "../shared/history.js";
import { analyzeAllocation, currentTaxYear, taxYearWindow, forwardDividends, marketStatus, moneyWeightedReturn, parseYearStart, summarizeIncome, summarizePerformance, summarizeTaxYear, timeWeightedReturn } from "./analytics.js";

const instrument = (ticker: string, currencyCode = "USD", type = "STOCK"): Instrument => ({ ticker, name: ticker, shortName: ticker, currencyCode, type });
const position = (ticker: string, value: number, currencyCode = "USD"): Position => ({
  instrument: instrument(ticker, currencyCode),
  quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: value, currentPrice: value,
  walletImpact: { currentValue: value, unrealizedProfitLoss: value * 0.1 },
});

describe("allocation analysis", () => {
  it("computes weights over the whole account and concentration over invested value", () => {
    const result = analyzeAllocation("demo", { currency: "EUR", cash: { availableToTrade: 200 } }, [position("AAPL_US_EQ", 600), position("VUSA_EQ", 200, "EUR")]);
    expect(result.totalValue).toBe(1000);
    expect(result.cashWeight).toBeCloseTo(0.2);
    expect(result.holdings[0]!.ticker).toBe("AAPL_US_EQ");
    expect(result.holdings[0]!.weight).toBeCloseTo(0.6);
    expect(result.concentration.largestWeight).toBeCloseTo(0.75);
    expect(result.concentration.effectiveHoldings).toBeCloseTo(1.6, 1);
    expect(result.byCurrency.map((item) => item.currency)).toEqual(["USD", "EUR"]);
    expect(result.flags.map((flag) => flag.code)).toContain("SINGLE_HOLDING_OVER_LIMIT");
  });

  it("gives each holding's exchange-rate part: Trading 212's, none in the account currency, and no guess without it", () => {
    const withRate = (base: Position, wallet: Record<string, unknown>): Position => ({ ...base, walletImpact: { ...base.walletImpact, currency: "EUR", ...wallet } });
    const result = analyzeAllocation("demo", { currency: "EUR" }, [withRate(position("AAPL_US_EQ", 600), { fxImpact: -12.5 }), withRate(position("VUSA_EQ", 200, "EUR"), {}), withRate(position("KO_US_EQ", 100), {})]);
    const of = (ticker: string) => result.holdings.find((item) => item.ticker === ticker);
    expect(of("AAPL_US_EQ")).toMatchObject({ unrealizedProfitLoss: 60, fxImpact: -12.5 });
    expect(of("VUSA_EQ")).toMatchObject({ fxImpact: 0 });
    expect(of("KO_US_EQ")).not.toHaveProperty("fxImpact");
  });

  it("keeps the cash free to trade apart from cash held for orders and in pies", () => {
    const result = analyzeAllocation("demo", { currency: "EUR", cash: { availableToTrade: 200, reservedForOrders: 50, inPies: 30 } }, [position("VUSA_EQ", 720, "EUR")]);
    expect(result.cash).toBe(280);
    expect(result.availableCash).toBe(200);
  });

  it("handles an empty account without dividing by zero", () => {
    const result = analyzeAllocation("demo", { currency: "EUR" }, []);
    expect(result.availableCash).toBeUndefined();
    expect(result.totalValue).toBe(0);
    expect(result.concentration.herfindahl).toBe(0);
    expect(result.flags).toEqual([]);
  });
});

const fill = (ticker: string, side: "BUY" | "SELL", filledAt: string, netValue: number, pnl: number, fees: number): HistoryOrderItem => ({
  order: { ticker, side, type: "MARKET", status: "FILLED" },
  fill: { filledAt, quantity: 1, price: netValue, walletImpact: { netValue, realisedProfitLoss: pnl, taxes: fees ? [{ name: "CURRENCY_CONVERSION_FEE", quantity: fees }] : [] } },
});

describe("performance summary", () => {
  const orders = [fill("AAPL_US_EQ", "SELL", "2026-06-01T10:00:00Z", 500, 80, 0.75), fill("AAPL_US_EQ", "BUY", "2025-01-01T10:00:00Z", 420, 0, 0.63)];
  const dividends: HistoryDividendItem[] = [{ ticker: "AAPL_US_EQ", amount: 3.2, paidOn: "2026-05-15T00:00:00Z" }];
  const transactions: HistoryTransactionItem[] = [
    { type: "DEPOSIT", amount: 1000, dateTime: "2024-12-30T00:00:00Z" },
    { type: "WITHDRAW", amount: -100, dateTime: "2026-02-01T00:00:00Z" },
    { type: "INTEREST_ON_FREE_CASH", amount: 1.5, dateTime: "2026-03-01T00:00:00Z" },
  ];

  it("totals realized P/L, income, costs and contributions for all time", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.realizedProfitLoss).toBe(80);
    expect(result.income).toEqual({ dividends: 3.2, interest: 1.5 });
    expect(result.costs.total).toBeCloseTo(1.38);
    expect(result.contributions).toEqual({ deposits: 1000, withdrawals: 100, net: 900 });
    expect(result.simpleReturn).toBeCloseTo(0.1);
    expect(result.trades).toMatchObject({ buys: 1, sells: 1 });
    // 1000 in on 2024-12-30, 100 out on 2026-02-01, 990 now: the rate that makes these flows net to zero.
    const years = (iso: string) => (Date.parse("2026-10-01T00:00:00Z") - Date.parse(iso)) / (365.25 * 86_400_000);
    const rate = result.annualizedReturn!;
    expect(-1000 * (1 + rate) ** years("2024-12-30T00:00:00Z") + 100 * (1 + rate) ** years("2026-02-01T00:00:00Z") + 990).toBeCloseTo(0, 0);
    expect(rate).toBeGreaterThan(0.04);
    expect(rate).toBeLessThan(0.07);
    expect(result.annualizedSince).toBe("2024-12-30T00:00:00.000Z");
  });

  it("keeps the exact ticker case so instrument names still resolve", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "GBP", totalValue: 990 }, orders: [fill("VUSAl_EQ", "SELL", "2026-06-01T10:00:00Z", 50, 5, 0)], dividends: [{ ticker: "VUSAl_EQ", amount: 1, paidOn: "2026-05-15T00:00:00Z" }], transactions, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.byTicker.map((item) => item.ticker)).toEqual(["VUSAl_EQ"]);
  });

  it("needs the window to reach the time the account was valued", () => {
    // Ends yesterday evening, less than a day before now, but a deposit made today would be missing.
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-09-30T23:59:59.999Z") }, truncated: false, now: new Date("2026-10-01T09:00:00Z") });
    expect(result.simpleReturn).toBeUndefined();
    const today = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-10-01T23:59:59.999Z") }, truncated: false, now: new Date("2026-10-01T09:00:00Z") });
    expect(today.simpleReturn).toBeCloseTo(0.1);
  });

  it("counts the year from the first deposit, not an earlier withdrawal", () => {
    const flows: HistoryTransactionItem[] = [
      { type: "WITHDRAW", amount: -50, dateTime: "2024-01-01T00:00:00Z" },
      { type: "DEPOSIT", amount: 1000, dateTime: "2026-06-01T00:00:00Z" },
    ];
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 1100 }, orders: [], dividends: [], transactions: flows, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.annualizedReturn).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/at least a year/);
  });

  it("leaves out the annualized return until there is a year of deposits", () => {
    const recent: HistoryTransactionItem[] = [{ type: "DEPOSIT", amount: 1000, dateTime: "2026-06-01T00:00:00Z" }];
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 1050 }, orders: [], dividends: [], transactions: recent, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.simpleReturn).toBeCloseTo(0.05);
    expect(result.annualizedReturn).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/at least a year/);
  });

  it("filters by window and omits the simple return for bounded periods", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") }, truncated: false });
    expect(result.coverage.orders).toBe(1);
    expect(result.contributions.deposits).toBe(0);
    expect(result.simpleReturn).toBeUndefined();
  });

  it("does not measure today's value against a window that ended earlier", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-06-30T23:59:59.999Z") }, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.contributions.withdrawals).toBe(100);
    expect(result.simpleReturn).toBeUndefined();
    expect(result.annualizedReturn).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/end before now/);
  });

  it("does not report a return when history is truncated", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: true, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.simpleReturn).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/truncated/);
  });
});

describe("money-weighted return", () => {
  const year = 365.25 * 86_400_000;
  it("finds the yearly rate of a single deposit", () => {
    expect(moneyWeightedReturn([{ at: 0, amount: -100 }, { at: year, amount: 110 }])).toBeCloseTo(0.1, 4);
    expect(moneyWeightedReturn([{ at: 0, amount: -100 }, { at: 2 * year, amount: 81 }])).toBeCloseTo(-0.1, 4);
  });

  it("has no answer without money both in and out", () => {
    expect(moneyWeightedReturn([{ at: 0, amount: -100 }])).toBeUndefined();
    expect(moneyWeightedReturn([{ at: 0, amount: -100 }, { at: year, amount: 0 }])).toBeUndefined();
  });
});

describe("time-weighted return", () => {
  const reading = (date: string, totalValue: number): ValuePoint => ({ date, totalValue, at: `${date}T12:00:00.000Z` });
  const at = (date: string, time = "12:00:00.000") => Date.parse(`${date}T${time}Z`);

  it("chains the change between readings when nothing was paid in or out", () => {
    const result = timeWeightedReturn([reading("2026-09-01", 100), reading("2026-09-02", 110), reading("2026-09-03", 99)], []);
    expect(result?.return).toBeCloseTo(-0.01, 6);
    expect(result?.series.map((point) => point.return)).toEqual([0, 0.1, -0.01]);
    expect(result).toMatchObject({ from: "2026-09-01", to: "2026-09-03", netFlows: 0 });
  });

  it("gives the deepest fall from a high, with a withdrawal neither a fall nor a deposit a rise", () => {
    // 1,000 to 1,100 (+10%); 600 taken out and 500 left at the third reading (no change); 1,000 paid in just after
    // it and 1,425 at the fourth (-5% on 1,500): only that last stretch fell.
    const result = timeWeightedReturn(
      [reading("2026-09-01", 1000), reading("2026-09-02", 1100), reading("2026-09-03", 500), reading("2026-09-04", 1425)],
      [{ at: at("2026-09-03", "00:00:00.000"), amount: -600 }, { at: at("2026-09-03", "12:00:00.001"), amount: 1000 }],
    );
    expect(result?.series.map((point) => point.return)).toEqual([0, 0.1, 0.1, 0.045]);
    expect(result?.drawdown).toEqual({ max: -0.05, peak: "2026-09-03", trough: "2026-09-04", current: -0.05, currentPeak: "2026-09-03" });
  });

  it("takes a deposit out of the gain and weighs it by how long it was invested", () => {
    // Paid in just before the second reading: it earned nothing, so the 100 gain is on the first 1,000.
    const late = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 2100), reading("2026-09-03", 2205)], [{ at: at("2026-09-02", "11:59:59.000"), amount: 1000 }]);
    expect(late?.series[1]?.return).toBeCloseTo(0.1, 4);
    expect(late?.return).toBeCloseTo(1.1 * 1.05 - 1, 4);
    expect(late?.netFlows).toBe(1000);
    // Paid in right after the first reading: it was invested all along, so the 200 gain is on 2,000.
    const early = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 2200)], [{ at: at("2026-09-01", "12:00:00.001"), amount: 1000 }]);
    expect(early?.return).toBeCloseTo(0.1, 4);
  });

  it("counts a withdrawal halfway through for half the stretch", () => {
    const result = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 550)], [{ at: at("2026-09-02", "00:00:00.000"), amount: -500 }]);
    expect(result?.return).toBeCloseTo(50 / 750, 6);
    expect(result?.netFlows).toBe(-500);
  });

  it("counts only the part of a stretch anything was invested in", () => {
    // An empty account funded an hour before the reading: the 10 gained is on the 1,000 paid in, not on an hour's share of it.
    const funded = timeWeightedReturn([reading("2026-09-01", 0), reading("2026-09-02", 1010)], [{ at: at("2026-09-02", "11:00:00.000"), amount: 1000 }]);
    expect(funded?.return).toBeCloseTo(0.01, 6);
    // Emptied an hour after the first reading: the 3 gained before it was taken out is on the 1,000 there.
    const emptied = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 0)], [{ at: at("2026-09-01", "13:00:00.000"), amount: -1003 }]);
    expect(emptied?.return).toBeCloseTo(0.003, 6);
    // A few euros left over count as empty next to the money moved.
    const leftOver = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 5)], [{ at: at("2026-09-01", "13:00:00.000"), amount: -998 }]);
    expect(leftOver?.return).toBeCloseTo(0.003, 6);
    // A withdrawal before the deposit, or a deposit after the withdrawal, doesn't move where the money was in.
    const late = timeWeightedReturn([reading("2026-09-01", 50), reading("2026-09-02", 10_100)],
      [{ at: at("2026-09-01", "13:00:00.000"), amount: -50 }, { at: at("2026-09-02", "11:00:00.000"), amount: 10_000 }]);
    expect(late?.return).toBeCloseTo(0.01, 6);
    const topUp = timeWeightedReturn([reading("2026-09-01", 1000), reading("2026-09-02", 5)],
      [{ at: at("2026-09-01", "13:00:00.000"), amount: -1003 }, { at: at("2026-09-02", "11:00:00.000"), amount: 5 }]);
    expect(topUp?.return).toBeCloseTo(0.003, 6);
  });

  it("starts measuring once money is in and gives up on a gain from nothing", () => {
    const funded = timeWeightedReturn([reading("2026-09-01", 0), reading("2026-09-02", 1000), reading("2026-09-03", 1100)], [{ at: at("2026-09-02", "12:00:00.000"), amount: 1000 }]);
    expect(funded?.series.map((point) => point.return)).toEqual([0, 0, 0.1]);
    expect(timeWeightedReturn([reading("2026-09-01", 0), reading("2026-09-02", 50)], [])).toBeUndefined();
    expect(timeWeightedReturn([reading("2026-09-01", 100)], [])).toBeUndefined();
  });

  it("is part of the performance summary for any window, but only with every flow since the first reading", () => {
    const values = [reading("2026-09-01", 1000), reading("2026-09-15", 1600), reading("2026-09-30", 1650)];
    const deposit: HistoryTransactionItem = { type: "DEPOSIT", amount: 500, dateTime: "2026-09-15T11:00:00Z" };
    const older: HistoryTransactionItem = { type: "DEPOSIT", amount: 900, dateTime: "2026-08-01T10:00:00Z" };
    const window = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };
    const base = { environment: "demo" as const, account: { currency: "EUR", totalValue: 1650 }, orders: [], dividends: [], window, values };
    const complete = summarizePerformance({ ...base, transactions: [deposit], truncated: false });
    expect(complete.simpleReturn).toBeUndefined();
    expect(complete.timeWeighted?.return).toBeCloseTo((1 + 100 / (1000 + 500 / 336)) * (1 + 50 / 1600) - 1, 6);
    expect(complete.timeWeighted?.netFlows).toBe(500);
    // Cut off after the first reading: a deposit before the cut could be missing.
    const cut = summarizePerformance({ ...base, transactions: [deposit], truncated: true, transactionsTruncated: true });
    expect(cut.timeWeighted).toBeUndefined();
    expect(cut.notes.join(" ")).toMatch(/timeWeighted is omitted/);
    // Cut off before it: everything since the first reading was read.
    const reached = summarizePerformance({ ...base, transactions: [deposit, older], truncated: true, transactionsTruncated: true });
    expect(reached.timeWeighted?.netFlows).toBe(500);
    // A transfer from another Trading 212 account is money paid in too.
    const transfer: HistoryTransactionItem = { type: "TRANSFER", amount: 500, dateTime: "2026-09-15T11:00:00Z" };
    expect(summarizePerformance({ ...base, transactions: [transfer], truncated: false }).timeWeighted?.return).toBeCloseTo(complete.timeWeighted!.return, 9);
    // Only the orders were cut off.
    expect(summarizePerformance({ ...base, transactions: [deposit], truncated: true, transactionsTruncated: false }).timeWeighted).toBeDefined();
  });
});

describe("tax year summary", () => {
  const orders = [
    fill("AAPL_US_EQ", "SELL", "2026-05-01T10:00:00Z", 500, 80, 0.75),
    fill("VUSAl_EQ", "SELL", "2026-03-01T10:00:00Z", 200, -30, 0),
    fill("VUSAl_EQ", "SELL", "2026-04-05T23:00:00Z", 100, 10, 0),
    fill("AAPL_US_EQ", "BUY", "2026-04-10T10:00:00Z", 420, 0, 0.63),
  ];
  const dividends: HistoryDividendItem[] = [{ ticker: "AAPL_US_EQ", amount: 3.2, paidOn: "2026-05-15T00:00:00Z" }, { ticker: "VUSAl_EQ", amount: 9, paidOn: "2026-01-15T00:00:00Z" }];
  const transactions: HistoryTransactionItem[] = [
    { type: "INTEREST_ON_FREE_CASH", amount: 1.5, dateTime: "2026-06-01T00:00:00Z" },
    { type: "FEE", amount: -2, dateTime: "2026-07-01T00:00:00Z" },
    { type: "DEPOSIT", amount: 1000, dateTime: "2026-04-07T00:00:00Z" },
  ];

  it("splits gains from losses inside a UK tax year", () => {
    const yearStart = parseYearStart("04-06");
    const result = summarizeTaxYear({ environment: "demo", accountCurrency: "GBP", orders, dividends, transactions, year: 2026, yearStart, truncated: false, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.period).toEqual({ from: "2026-04-06T00:00:00.000Z", to: "2027-04-05T23:59:59.999Z" });
    expect(result.ended).toBe(false);
    expect(result.disposals).toEqual({ count: 1, proceeds: 500, gains: 80, losses: 0, net: 80 });
    expect(result.income).toEqual({ dividends: 3.2, interest: 1.5 });
    expect(result.costs.total).toBeCloseTo(3.38);
    expect(result.notes.join(" ")).toMatch(/still running/);
  });

  it("covers a finished calendar year", () => {
    const result = summarizeTaxYear({ environment: "demo", accountCurrency: "GBP", orders, dividends, transactions, year: 2026, yearStart: parseYearStart(undefined), truncated: false, now: new Date("2027-02-01T00:00:00Z") });
    expect(result.ended).toBe(true);
    expect(result.disposals).toEqual({ count: 3, proceeds: 800, gains: 90, losses: -30, net: 60 });
    expect(result.byTicker[0]).toEqual({ ticker: "AAPL_US_EQ", disposals: 1, proceeds: 500, realizedProfitLoss: 80 });
    expect(result.byTicker[1]).toEqual({ ticker: "VUSAl_EQ", disposals: 2, proceeds: 300, realizedProfitLoss: -20 });
    expect(result.income.dividends).toBe(12.2);
  });

  it("counts days in the tax payer's time zone", () => {
    const result = summarizeTaxYear({
      environment: "demo", accountCurrency: "GBP", year: 2026, yearStart: parseYearStart("04-06"), timeZone: "Europe/London", truncated: false, now: new Date("2027-05-01T00:00:00Z"),
      // 00:30 on 6 April in London is still 5 April in UTC.
      orders: [fill("VUSAl_EQ", "SELL", "2026-04-05T23:30:00Z", 100, 10, 0), fill("VUSAl_EQ", "SELL", "2027-04-05T23:30:00Z", 100, 5, 0)],
      dividends: [], transactions: [],
    });
    expect(result.period).toEqual({ from: "2026-04-05T23:00:00.000Z", to: "2027-04-05T22:59:59.999Z" });
    expect(result).toMatchObject({ firstDay: "2026-04-06", lastDay: "2027-04-05", timeZone: "Europe/London" });
    expect(result.disposals).toMatchObject({ count: 1, gains: 10 });
  });

  it("dates sales by their fill and leaves out values it cannot put in the account currency", () => {
    const undated: HistoryOrderItem = { order: { ticker: "AAPL_US_EQ", side: "SELL", createdAt: "2026-02-01T00:00:00Z" }, fill: { quantity: -1, price: 200, walletImpact: { netValue: 180, realisedProfitLoss: 20 } } };
    const unvalued: HistoryOrderItem = { order: { ticker: "AAPL_US_EQ", side: "SELL" }, fill: { filledAt: "2026-03-01T00:00:00Z", quantity: -1, price: 210, walletImpact: { realisedProfitLoss: 15 } } };
    const result = summarizeTaxYear({ environment: "demo", accountCurrency: "GBP", orders: [undated, unvalued], dividends: [], transactions: [], year: 2026, yearStart: parseYearStart("01-01"), truncated: false, now: new Date("2027-02-01T00:00:00Z") });
    expect(result.disposals).toEqual({ count: 1, proceeds: 0, gains: 15, losses: 0, net: 15 });
    expect(result.notes.join(" ")).toMatch(/1 sale\(s\) had no account-currency value/);
    expect(result.notes.join(" ")).toMatch(/1 fill\(s\) had no fill date/);
  });

  it("matches a UK year on UK days whatever zone the summary counts in, so no sale falls in two years", () => {
    const orders: HistoryOrderItem[] = [
      { order: { ticker: "A", side: "BUY" }, fill: { filledAt: "2025-01-10T10:00:00Z", quantity: 10, walletImpact: { netValue: -100 } } },
      // 01:00 on 6 April 2025 in London (2025/26); 20:00 on 5 April in New York.
      { order: { ticker: "A", side: "SELL" }, fill: { filledAt: "2025-04-06T00:00:00Z", quantity: -5, walletImpact: { netValue: 80, realisedProfitLoss: 30 } } },
    ];
    const ukHistory = { orders, complete: true };
    const base = { environment: "demo" as const, accountCurrency: "GBP", orders, dividends: [], transactions: [], yearStart: parseYearStart("04-06"), timeZone: "America/New_York", truncated: false, ukHistory, now: new Date("2026-10-01T00:00:00Z") };
    const earlier = summarizeTaxYear({ ...base, year: 2024 });
    const later = summarizeTaxYear({ ...base, year: 2025 });
    expect(earlier.disposals.count).toBe(1);
    expect(earlier.ukMatching?.byTicker).toEqual([]);
    expect(later.ukMatching?.byTicker[0]).toMatchObject({ ticker: "A", pool: 5, gain: 30, realizedProfitLoss: 30 });
    expect(later.ukMatching?.notes.join(" ")).toMatch(/count days in America\/New_York.*UK time/);
  });

  it("reads the year start and picks the latest started tax year", () => {
    expect(parseYearStart("04-06")).toEqual({ month: 4, day: 6, text: "04-06" });
    expect(parseYearStart("02-30").text).toBe("01-01");
    expect(currentTaxYear({ month: 4, day: 6 }, new Date("2026-04-05T12:00:00Z"))).toBe(2025);
    expect(currentTaxYear({ month: 4, day: 6 }, new Date("2026-04-06T00:00:00Z"))).toBe(2026);
    // Where clocks jump forward at midnight there is no 00:00: the day starts when they jump (01:00 in Santiago).
    expect(taxYearWindow(2026, { month: 9, day: 6 }, "America/Santiago").from.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(taxYearWindow(2026, { month: 4, day: 6 }, "Europe/London").from.toISOString()).toBe("2026-04-05T23:00:00.000Z");
    expect(currentTaxYear({ month: 4, day: 6 }, new Date("2026-04-05T23:30:00Z"), "Europe/London")).toBe(2026);
    expect(currentTaxYear({ month: 1, day: 1 }, new Date("2026-12-31T23:30:00Z"), "Europe/Berlin")).toBe(2027);
  });
});

describe("income summary", () => {
  it("groups dividends and interest by month and computes trailing 12 months", () => {
    const result = summarizeIncome({
      environment: "demo", accountCurrency: "EUR", truncated: false,
      window: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") },
      dividends: [{ ticker: "A", amount: 2, paidOn: "2026-02-10T00:00:00Z" }, { ticker: "B", amount: 3, paidOn: "2025-11-10T00:00:00Z" }],
      transactions: [{ type: "INTEREST_ON_FREE_CASH", amount: 1, dateTime: "2026-02-01T00:00:00Z" }, { type: "DEPOSIT", amount: 50, dateTime: "2026-02-01T00:00:00Z" }],
    });
    expect(result.total).toBe(3);
    expect(result.byMonth).toEqual([{ key: "2026-02", amount: 3 }]);
    expect(result.trailing12Months).toBe(6);
  });
});

describe("market status", () => {
  const exchanges: Exchange[] = [{ id: 1, name: "NASDAQ", workingSchedules: [{ id: 7, timeEvents: [
    { date: "2026-10-09T08:00:00Z", type: "PRE_MARKET_OPEN" },
    { date: "2026-10-09T13:30:00Z", type: "OPEN" },
    { date: "2026-10-09T20:00:00Z", type: "CLOSE" },
    { date: "2026-10-12T13:30:00Z", type: "OPEN" },
    { date: "2026-10-12T20:00:00Z", type: "CLOSE" },
  ] }] }];
  const nvda = { ...instrument("NVDA_US_EQ"), workingScheduleId: 7 };

  it("reports the regular session while open", () => {
    expect(marketStatus(nvda, exchanges, new Date("2026-10-09T15:00:00Z"))).toMatchObject({ session: "regular", isOpen: true, exchange: "NASDAQ", nextClose: "2026-10-09T20:00:00.000Z" });
  });

  it("reports closed with the next open over a weekend", () => {
    expect(marketStatus(nvda, exchanges, new Date("2026-10-10T23:00:00Z"))).toMatchObject({ session: "closed", isOpen: false, nextOpen: "2026-10-12T13:30:00.000Z" });
  });

  it("is unknown without schedule data", () => {
    expect(marketStatus(instrument("X"), exchanges).session).toBe("unknown");
  });
});

describe("forward dividends", () => {
  it("projects each holding's trailing per-share payments onto the current quantity", () => {
    const instrument = { ticker: "VUSA_EQ", name: "VUSA", shortName: "VUSA", currencyCode: "EUR" };
    const result = forwardDividends(
      [
        { ticker: "VUSA_EQ", amount: 5, quantity: 10, paidOn: "2026-03-01T00:00:00Z" },
        { ticker: "VUSA_EQ", amount: 6, quantity: 12, paidOn: "2026-06-01T00:00:00Z" },
        { ticker: "VUSA_EQ", amount: 50, quantity: 10, paidOn: "2024-06-01T00:00:00Z" },
        { ticker: "SOLD_EQ", amount: 9, quantity: 3, paidOn: "2026-05-01T00:00:00Z" },
      ],
      [{ instrument, quantity: 20, quantityAvailableForTrading: 20, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 }],
      new Date("2026-10-01T00:00:00Z"),
    );
    // Two payments three months apart: a quarterly payer held for half a year, so the year has four.
    expect(result.byTicker).toEqual([{ key: "VUSA_EQ", amount: 40 }]);
    expect(result.total).toBe(40);
    expect(result.yieldOnValue).toBe(0.02);
  });

  it("does not scale a full year of payments or a single payment", () => {
    const instrument = { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO", currencyCode: "EUR" };
    const holding = [{ instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 50, currentPrice: 60 }];
    const quarterly = ["2025-12-01", "2026-03-01", "2026-06-01", "2026-09-01"].map((day) => ({ ticker: "KO_US_EQ", amount: 5, quantity: 10, paidOn: `${day}T00:00:00Z` }));
    expect(forwardDividends(quarterly, holding, new Date("2026-10-01T00:00:00Z")).total).toBe(20);
    expect(forwardDividends(quarterly.slice(-1), holding, new Date("2026-10-01T00:00:00Z")).total).toBe(5);
  });

  it("lays the payments out over this month and the next 11, beside what was paid this month", () => {
    const holding = (ticker: string, quantity: number) => ({ instrument: { ticker, name: ticker, shortName: ticker, currencyCode: "EUR" }, quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: 50, currentPrice: 60 });
    const quarterly = ["2025-12-01", "2026-03-01", "2026-06-01", "2026-09-01"].map((day) => ({ ticker: "KO_US_EQ", amount: 5, quantity: 10, paidOn: `${day}T00:00:00Z` }));
    const result = forwardDividends(
      [...quarterly, { ticker: "VUSA_EQ", amount: 12, quantity: 6, paidOn: "2026-10-03T10:00:00Z" }, { ticker: "SOLD_EQ", amount: 3, quantity: 3, paidOn: "2026-10-05T10:00:00Z" }],
      [holding("KO_US_EQ", 20), holding("VUSA_EQ", 6)],
      new Date("2026-10-12T09:00:00Z"),
    );
    expect(result.calendar).toHaveLength(12);
    expect(result.calendar![0]).toEqual({ month: "2026-10", paid: 15, expected: 0 });
    expect(result.calendar![2]).toEqual({ month: "2026-12", paid: 0, expected: 10 });
    expect(result.calendar![11]).toEqual({ month: "2027-09", paid: 0, expected: 10 });
    // Coca-Cola's four quarters at today's 20 shares; the fund paid once, this month, so not again within the calendar.
    expect(result.upcoming).toEqual([
      { ticker: "KO_US_EQ", on: "2026-12-01", amount: 10 },
      { ticker: "KO_US_EQ", on: "2027-03-01", amount: 10 },
      { ticker: "KO_US_EQ", on: "2027-06-01", amount: 10 },
      { ticker: "KO_US_EQ", on: "2027-09-01", amount: 10 },
    ]);
    expect(result.total).toBe(52);
  });

  it("still expects last year's payment due this month and not paid yet, and only the newest year's paydays", () => {
    const holding = [{ instrument: { ticker: "ULVR_EQ", name: "Unilever", shortName: "ULVR", currencyCode: "GBP" }, quantity: 100, quantityAvailableForTrading: 100, quantityInPies: 0, averagePricePaid: 40, currentPrice: 45 }];
    // A large final in October, a small interim in April: on the 25th, this October's final has not come yet.
    const paid = [{ ticker: "ULVR_EQ", amount: 60, quantity: 100, paidOn: "2025-10-20T09:00:00Z" }, { ticker: "ULVR_EQ", amount: 20, quantity: 100, paidOn: "2026-04-20T09:00:00Z" }];
    const late = forwardDividends(paid, holding, new Date("2026-10-25T12:00:00Z"));
    expect(late.total).toBe(80);
    expect(late.upcoming).toEqual([{ ticker: "ULVR_EQ", on: "2026-10-20", amount: 60 }, { ticker: "ULVR_EQ", on: "2027-04-20", amount: 20 }]);
    // Once it has come, last year's is not counted again.
    const done = forwardDividends([...paid, { ticker: "ULVR_EQ", amount: 66, quantity: 100, paidOn: "2026-10-22T09:00:00Z" }], holding, new Date("2026-10-25T12:00:00Z"));
    expect(done.total).toBe(86);
    expect(done.calendar![0]).toEqual({ month: "2026-10", paid: 66, expected: 0 });
    expect(done.upcoming).toEqual([{ ticker: "ULVR_EQ", on: "2027-04-22", amount: 20 }]);
  });

  it("gives no calendar for a period that ends in another month", () => {
    const holding = [{ instrument: { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO", currencyCode: "EUR" }, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 50, currentPrice: 60 }];
    const paid = ["2025-03-01", "2025-06-01", "2025-09-01", "2025-12-01"].map((day) => ({ ticker: "KO_US_EQ", amount: 5, quantity: 10, paidOn: `${day}T00:00:00Z` }));
    const past = forwardDividends(paid, holding, new Date("2025-12-31T00:00:00Z"), new Date("2026-10-12T09:00:00Z"));
    expect(past.total).toBe(20);
    expect(past.calendar).toBeUndefined();
    expect(past.upcoming).toBeUndefined();
  });
});
