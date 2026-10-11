import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { impliedFxRates, planRebalance } from "./rebalance.js";

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

  it("needs an FX rate for a currency no holding values", () => {
    const usd = [held("SPY", 2, 500, "USD")];
    expect(planRebalance("demo", account, usd, [{ ticker: "SPY", weight: 0.2 }]).skipped[0]?.reason).toMatch(/fxRates/);
    const plan = planRebalance("demo", account, usd, [{ ticker: "SPY", weight: 0.2 }], { fxRates: { USD: 1.25 }, quantityDecimals: 0 });
    // Holding 2 × 500 USD = 800 EUR; target 2000 EUR → buy 1200 EUR = 1500 USD = 3 shares
    expect(plan.trades[0]).toMatchObject({ side: "buy", quantity: 3 });
  });

  it("takes FX rates from the broker's valuation of holdings", () => {
    // 2 × 500 USD valued at 800 EUR by the broker → 1.25 USD per EUR.
    const valued: Position[] = [{ ...held("SPY", 2, 500, "USD"), walletImpact: { currency: "EUR", currentValue: 800 } }];
    expect(impliedFxRates(valued, "EUR")).toEqual({ USD: 1.25 });
    const plan = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.2 }, { ticker: "QQQ", weight: 0.05, referencePrice: 250 }], { quantityDecimals: 0 }, (ticker) => (ticker === "QQQ" ? "USD" : undefined));
    expect(plan.skipped).toEqual([]);
    expect(plan.trades.map((trade) => [trade.ticker, trade.quantity])).toEqual([["SPY", 3], ["QQQ", 2]]);
    expect(plan.notes.join(" ")).toMatch(/Exchange rates for USD/);
    // A rate you pass wins.
    const passed = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.2 }], { fxRates: { USD: 1 }, quantityDecimals: 0 });
    expect(passed.notes.join(" ")).not.toMatch(/Exchange rates/);
  });

  it("invests only spare cash in buy-only mode, most to the furthest below", () => {
    // EQ is 2000 over its 4000 target and is not sold; BOND is 2000 under and NEW 1000 under.
    const targets = [{ ticker: "EQ", weight: 0.4 }, { ticker: "BOND", weight: 0.4 }, { ticker: "NEW", weight: 0.1, referencePrice: 10 }];
    const plan = planRebalance("demo", account, positions, targets, { buyOnly: true, cashWeight: 0.05, quantityDecimals: 0 }, () => "EUR");
    expect(plan.buyOnly).toBe(true);
    expect(plan.trades.every((trade) => trade.side === "buy")).toBe(true);
    // 1500 above the 500 reserve, split 2000 : 1000 between BOND and NEW.
    expect(plan.trades.map((trade) => [trade.ticker, trade.value])).toEqual([["BOND", 1000], ["NEW", 500]]);
    expect(plan.cashAfter).toBe(500);
    expect(plan.noteDetails?.find((note) => note.code === "buy_only")?.details).toEqual({ budget: 1500, currency: "EUR" });
    expect(plan.notes.join(" ")).not.toMatch(/scaled/);
  });

  it("caps buy-only at the amount asked for and says when cash is short", () => {
    const targets = [{ ticker: "EQ", weight: 0.5 }, { ticker: "BOND", weight: 0.5 }];
    const capped = planRebalance("demo", account, positions, targets, { investAmount: 300, quantityDecimals: 0 });
    expect(capped.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["buy", "BOND", 6]]);
    const asked = planRebalance("demo", account, positions, targets, { investAmount: 5000, quantityDecimals: 0 });
    expect(asked.noteDetails?.find((note) => note.code === "amount_capped")?.details).toEqual({ amount: 5000, available: 2000, currency: "EUR" });
    const broke = planRebalance("demo", { ...account, cash: { availableToTrade: 0 } }, positions, targets, { buyOnly: true });
    expect(broke.trades).toEqual([]);
    expect(broke.noteDetails?.map((note) => note.code)).toContain("no_cash");
    expect(() => planRebalance("demo", account, positions, targets, { investAmount: 0 })).toThrow(/investAmount/);
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
