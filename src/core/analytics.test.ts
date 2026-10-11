import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import type { Exchange, HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem } from "../shared/history.js";
import { analyzeAllocation, marketStatus, summarizeIncome, summarizePerformance } from "./analytics.js";

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

  it("handles an empty account without dividing by zero", () => {
    const result = analyzeAllocation("demo", { currency: "EUR" }, []);
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
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: false });
    expect(result.realizedProfitLoss).toBe(80);
    expect(result.income).toEqual({ dividends: 3.2, interest: 1.5 });
    expect(result.costs.total).toBeCloseTo(1.38);
    expect(result.contributions).toEqual({ deposits: 1000, withdrawals: 100, net: 900 });
    expect(result.simpleReturn).toBeCloseTo(0.1);
    expect(result.trades).toMatchObject({ buys: 1, sells: 1 });
  });

  it("filters by window and omits the simple return for bounded periods", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") }, truncated: false });
    expect(result.coverage.orders).toBe(1);
    expect(result.contributions.deposits).toBe(0);
    expect(result.simpleReturn).toBeUndefined();
  });

  it("does not report a return when history is truncated", () => {
    const result = summarizePerformance({ environment: "demo", account: { currency: "EUR", totalValue: 990 }, orders, dividends, transactions, window: { to: new Date("2026-10-01T00:00:00Z") }, truncated: true });
    expect(result.simpleReturn).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/truncated/);
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
