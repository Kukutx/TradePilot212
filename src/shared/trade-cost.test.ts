import { describe, expect, it } from "vitest";
import { DEFAULT_FX_FEE_RATE, fundBuys, rebalanceEstimate, tradeTotals, weightTrades } from "./trade-cost";

describe("trade totals", () => {
  it("adds the buys and sells and the fee on the ones in another currency", () => {
    const totals = tradeTotals([
      { side: "sell", value: 1200, currency: "USD" },
      { side: "buy", value: 800, currency: "GBX" },
      { side: "buy", value: 400.004, currency: "EUR" },
    ], "GBP");
    // Pence are pounds: only the dollar sell and the euro buy are converted.
    expect(totals).toEqual({ currency: "GBP", bought: 1200, sold: 1200, converted: 1600, fxFee: 2.4, fxFeeRate: DEFAULT_FX_FEE_RATE });
  });

  it("counts a trade in a currency not known as converted, and says how many", () => {
    expect(tradeTotals([{ side: "buy", value: 1000 }, { side: "buy", value: 500, currency: "eur" }], "EUR", 0.001))
      .toEqual({ currency: "EUR", bought: 1500, sold: 0, converted: 1000, fxFee: 1, fxFeeRate: 0.001, unknownCurrency: 1 });
  });

  it("takes the \"?\" an unknown currency is shown as for no currency", () => {
    expect(tradeTotals([{ side: "buy", value: 100, currency: "?" }], "GBP")).toMatchObject({ converted: 100, unknownCurrency: 1 });
  });

  it("charges nothing at a rate of 0 and leaves out empty trades", () => {
    expect(tradeTotals([{ side: "sell", value: 300, currency: "USD" }, { side: "buy", value: 0, currency: "USD" }], "EUR", 0))
      .toEqual({ currency: "EUR", bought: 0, sold: 300, converted: 300, fxFee: 0, fxFeeRate: 0 });
  });
});

describe("weight trades", () => {
  it("moves each line by its change in weight times the account's value, leaving out the small ones", () => {
    const trades = weightTrades([
      { ticker: "A", current: 0.6, target: 0.5, currency: "USD" },
      { ticker: "B", current: 0, target: 0.2 },
      { ticker: "C", current: 0.3, target: 0.30005 },
    ], 10_000);
    // C would move by 0.50, below the planner's minimum trade of 1.
    expect(trades.map((trade) => [trade.ticker, trade.side, Math.round(trade.value * 100) / 100, trade.currency])).toEqual([
      ["A", "sell", 1000, "USD"],
      ["B", "buy", 2000, undefined],
    ]);
    expect(weightTrades([{ ticker: "C", current: 0.3, target: 0.3002 }], 10_000)).toHaveLength(1);
    // Within the rounding of a target to 0.01%, nothing moves, however large the account.
    expect(weightTrades([{ ticker: "C", current: 0.30004, target: 0.3 }, { ticker: "D", current: 0.19995, target: 0.2 }], 1_000_000)).toEqual([]);
    expect(weightTrades([{ ticker: "C", current: 0.30006, target: 0.3 }], 1_000_000)).toHaveLength(1);
    expect(weightTrades([{ ticker: "A", current: 0.6, target: 0.5 }], 0)).toEqual([]);
  });
});

describe("buys fitted to the cash", () => {
  const trades = [
    { side: "sell" as const, value: 1000, currency: "USD" },
    { side: "buy" as const, value: 1500, currency: "EUR" },
    { side: "buy" as const, value: 1500, currency: "USD" },
  ];

  it("pays for the buys and their fee with the spare cash and what the sells raise net of the fee", () => {
    // 2010 spare + 998.5 from the sell covers 3000 of buys and the 2.25 fee on the dollar one.
    expect(fundBuys(trades, 2010, "EUR")).toEqual({ trades, scale: 1 });
    // 1001.5 + 998.5 = 2000 pays for two thirds of the buys, their fee included.
    const short = fundBuys(trades, 1001.5, "EUR");
    expect(short.scale).toBeCloseTo(2000 / 3002.25, 6);
    expect(short.trades.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.value * (trade.currency === "USD" ? 1.0015 : 1), 0)).toBeCloseTo(2000, 6);
    // No spare cash and nothing sold: no buys.
    expect(fundBuys(trades.slice(1), -50, "EUR")).toEqual({ trades: [], scale: 0 });
  });

  it("makes the buys a hair smaller when only the fee is short, without calling them scaled", () => {
    const fitted = fundBuys([{ side: "buy", value: 1000, currency: "USD" }], 1000, "EUR");
    expect(fitted.scale).toBe(1);
    expect(fitted.trades[0]!.value * 1.0015).toBeCloseTo(1000, 6);
  });

  it("estimates a rebalance by weight, fitted to the cash when it is known", () => {
    const moves = [{ ticker: "A", current: 0.35, target: 0.5, currency: "USD" }, { ticker: "B", current: 0.35, target: 0.5, currency: "GBP" }];
    // Without the cash, every buy; with none to spare, none, and it says the cash fell short.
    expect(rebalanceEstimate(moves, 10_000, "GBP")).toMatchObject({ bought: 3000, sold: 0, converted: 1500, fxFee: 2.25 });
    expect(rebalanceEstimate(moves, 10_000, "GBP", DEFAULT_FX_FEE_RATE, 0)).toEqual({ currency: "GBP", bought: 0, sold: 0, converted: 0, fxFee: 0, fxFeeRate: DEFAULT_FX_FEE_RATE, buysScaled: 0 });
    expect(rebalanceEstimate(moves, 10_000, "GBP", DEFAULT_FX_FEE_RATE, 1500)).toMatchObject({ buysScaled: 0.4996 });
  });
});
