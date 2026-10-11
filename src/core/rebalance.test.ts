import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { planRebalance } from "./rebalance.js";

const etf = (ticker: string, currencyCode = "EUR"): Instrument => ({ ticker, name: ticker, shortName: ticker, currencyCode, type: "ETF" });
const held = (ticker: string, quantity: number, price: number, currency = "EUR"): Position => ({
  instrument: etf(ticker, currency), quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: price, currentPrice: price,
});

// 6000 EQ + 2000 BOND + 2000 cash = 10000
const account = { currency: "EUR", totalValue: 10_000, cash: { availableToTrade: 2000 } };
const positions = [held("EQ", 60, 100), held("BOND", 40, 50)];

describe("rebalance planner", () => {
  it("sells the overweight holding and buys the underweight one", () => {
    const plan = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.5 }, { ticker: "BOND", weight: 0.5 }], { quantityDecimals: 0 });
    expect(plan.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["sell", "EQ", 10], ["buy", "BOND", 60]]);
    expect(plan.cashAfter).toBe(0);
    expect(plan.trades.find((trade) => trade.ticker === "BOND")?.resultingWeight).toBe(0.5);
  });

  it("keeps a cash reserve and scales buys to the cash available", () => {
    // 1000 of the 2000 cash is reserved for open orders, so only 1000 is available to trade.
    const short = { ...account, cash: { availableToTrade: 1000 } };
    const plan = planRebalance("demo", short, positions, [{ ticker: "EQ", weight: 0.6 }, { ticker: "BOND", weight: 0.35 }], { cashWeight: 0.05, quantityDecimals: 0 });
    const buy = plan.trades.find((trade) => trade.side === "buy");
    expect(buy?.ticker).toBe("BOND");
    expect(buy?.quantity).toBe(10); // 500 above the 500 reserve, 50 per share
    expect(plan.notes.join(" ")).toMatch(/scaled/);
  });

  it("needs a reference price for instruments that are not held", () => {
    const plan = planRebalance("demo", account, positions, [{ ticker: "NEW", weight: 0.1 }], {}, () => "EUR");
    expect(plan.skipped[0]?.reason).toMatch(/referencePrice/);
    const priced = planRebalance("demo", account, positions, [{ ticker: "NEW", weight: 0.1, referencePrice: 25 }], { quantityDecimals: 0 }, () => "EUR");
    expect(priced.trades[0]).toMatchObject({ ticker: "NEW", side: "buy", quantity: 40 });
  });

  it("converts other currencies only with an explicit FX rate", () => {
    const usd = [held("SPY", 2, 500, "USD")];
    expect(planRebalance("demo", account, usd, [{ ticker: "SPY", weight: 0.2 }]).skipped[0]?.reason).toMatch(/fxRates/);
    const plan = planRebalance("demo", account, usd, [{ ticker: "SPY", weight: 0.2 }], { fxRates: { USD: 1.25 }, quantityDecimals: 0 });
    // Holding 2 × 500 USD = 800 EUR; target 2000 EUR → buy 1200 EUR = 1500 USD = 3 shares
    expect(plan.trades[0]).toMatchObject({ side: "buy", quantity: 3 });
  });

  it("sells untargeted holdings only when asked", () => {
    expect(planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.6 }]).trades).toEqual([]);
    const plan = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.6 }], { sellUntargeted: true });
    expect(plan.trades[0]).toMatchObject({ ticker: "BOND", side: "sell", quantity: 40 });
  });

  it("rejects targets above 100% and duplicates", () => {
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.8 }, { ticker: "BOND", weight: 0.3 }])).toThrow(/exceed 100%/);
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.3 }, { ticker: "eq", weight: 0.3 }])).toThrow(/more than once/);
  });
});
