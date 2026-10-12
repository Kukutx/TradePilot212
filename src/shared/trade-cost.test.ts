import { describe, expect, it } from "vitest";
import { DEFAULT_FX_FEE_RATE, tradeTotals, weightTrades } from "./trade-cost";

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
    expect(weightTrades([{ ticker: "A", current: 0.6, target: 0.5 }], 0)).toEqual([]);
  });
});
