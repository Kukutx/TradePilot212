import { describe, expect, it } from "vitest";
import type { Position } from "./contracts";
import { resultSplit, resultSplitOf } from "./result-split";

const position = (currencyCode: string, walletImpact: Record<string, unknown>): Position => ({
  instrument: { ticker: `X_${currencyCode}`, name: "X", shortName: "X", currencyCode },
  quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 1, currentPrice: 1, walletImpact,
});

describe("the unrealized result by source", () => {
  it("takes Trading 212's exchange-rate part and leaves the rest to the price", () => {
    expect(resultSplit(position("USD", { currency: "EUR", unrealizedProfitLoss: 636.55, fxImpact: -60.62 }))).toEqual({ total: 636.55, price: 697.17, fx: -60.62, foreign: true });
    // A loss on the price can hide behind a gain on the rate.
    expect(resultSplit(position("GBX", { currency: "EUR", unrealizedProfitLoss: 20, fxImpact: 50 }))).toEqual({ total: 20, price: -30, fx: 50, foreign: true });
  });

  it("puts nothing on the rate for an instrument in the account's currency, pence in pounds included", () => {
    expect(resultSplit(position("EUR", { currency: "EUR", unrealizedProfitLoss: 12.5 }))).toEqual({ total: 12.5, price: 12.5, fx: 0, foreign: false });
    expect(resultSplit(position("GBX", { currency: "GBP", unrealizedProfitLoss: 12.5, fxImpact: null }))).toEqual({ total: 12.5, price: 12.5, fx: 0, foreign: false });
  });

  it("does not guess a foreign holding's rate part, or split a result it does not have", () => {
    expect(resultSplit(position("USD", { currency: "EUR", unrealizedProfitLoss: 12.5 }))).toBeUndefined();
    expect(resultSplit(position("USD", { unrealizedProfitLoss: 12.5, fxImpact: "1" }))).toBeUndefined();
    expect(resultSplit(position("USD", { currency: "EUR", fxImpact: -3 }))).toBeUndefined();
  });

  it("adds the holdings up, and gives nothing when one of them cannot be split", () => {
    const usd = position("USD", { currency: "EUR", unrealizedProfitLoss: 100.1, fxImpact: -20.05 });
    const eur = position("EUR", { currency: "EUR", unrealizedProfitLoss: -30 });
    // Bought at today's rate: in another currency, with nothing on the rate yet.
    const fresh = position("USD", { currency: "EUR", unrealizedProfitLoss: 0, fxImpact: 0 });
    expect(resultSplitOf([usd, eur, fresh])).toEqual({ total: 70.1, price: 90.15, fx: -20.05, foreign: 2 });
    expect(resultSplitOf([usd, position("USD", { currency: "EUR", unrealizedProfitLoss: 5 })])).toBeUndefined();
    // The account's result may hold a holding's P/L that the holding does not give, so nothing is split.
    expect(resultSplitOf([usd, position("USD", { currency: "EUR" })])).toBeUndefined();
    expect(resultSplitOf([])).toBeUndefined();
  });
});
