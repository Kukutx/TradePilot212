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

  it("totals the trades and estimates the conversion fee on the ones in another currency", () => {
    // EUR account: SPY is valued in dollars, the bond fund in euros.
    const valued: Position[] = [{ ...held("SPY", 10, 500, "USD"), walletImpact: { currency: "EUR", currentValue: 4000 } }, held("BOND", 80, 50)];
    const plan = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.3 }, { ticker: "BOND", weight: 0.5 }], { quantityDecimals: 0 });
    // SPY: 4000 EUR to 3000 EUR, 2.5 shares at 400 EUR each, whole shares only so 2 (800 EUR); BOND: 4000 to 5000, 20 shares.
    expect(plan.trades.map((trade) => [trade.side, trade.ticker, trade.value])).toEqual([["sell", "SPY", 800], ["buy", "BOND", 1000]]);
    expect(plan.totals).toEqual({ currency: "EUR", bought: 1000, sold: 800, converted: 800, fxFee: 1.2, fxFeeRate: 0.0015 });
    expect(plan.noteDetails?.find((note) => note.code === "fx_fee")?.details).toEqual({ converted: 800, fee: 1.2, rate: 0.0015, currency: "EUR" });
    expect(plan.notes.join(" ")).toMatch(/Trading 212's 0\.15% conversion fee on them is about 1\.2 EUR/);
    // The fee comes off the dollar sell's proceeds, so the cash after is net of it.
    expect(plan.cashAfter).toBe(1798.8);
    // A rate of 0 counts no fee and says nothing about it; trades all in the account currency have none either.
    const free = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.3 }, { ticker: "BOND", weight: 0.5 }], { quantityDecimals: 0, fxFeeRate: 0 });
    expect(free.totals).toMatchObject({ converted: 800, fxFee: 0, fxFeeRate: 0 });
    expect(free.noteDetails?.map((note) => note.code)).not.toContain("fx_fee");
    const home = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.5 }, { ticker: "BOND", weight: 0.5 }], { quantityDecimals: 0 });
    expect(home.totals).toMatchObject({ bought: 3000, sold: 1000, converted: 0, fxFee: 0 });
    expect(home.noteDetails?.map((note) => note.code)).not.toContain("fx_fee");
  });

  it("leaves room for the conversion fee when the buys take all the free cash", () => {
    // 2000 EUR free and SPY 3000 EUR under its target: the buys and the fee on them come to no more than the cash.
    const valued: Position[] = [{ ...held("SPY", 2, 500, "USD"), walletImpact: { currency: "EUR", currentValue: 800 } }];
    const plan = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.38 }]);
    const bought = plan.totals!.bought;
    expect(bought + plan.totals!.fxFee).toBeLessThanOrEqual(2000);
    expect(bought).toBeGreaterThan(1990);
    expect(plan.cashAfter).toBeGreaterThanOrEqual(0);
    expect(plan.cashAfter).toBeLessThan(1);
    // Investing a set amount counts the fee in it.
    const amount = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.38 }], { investAmount: 1000 });
    expect(amount.totals!.bought + amount.totals!.fxFee).toBeLessThanOrEqual(1000);
    expect(amount.cashAfter).toBeGreaterThanOrEqual(1000);
  });

  it("says buys are scaled only when the cash falls short of the buys, not of their fee", () => {
    const valued: Position[] = [{ ...held("SPY", 2, 500, "USD"), walletImpact: { currency: "EUR", currentValue: 800 } }];
    // 2000 free, SPY 2000 under: the cash covers the buy but not its fee.
    const fee = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.28 }]);
    expect(fee.noteDetails?.map((note) => note.code)).not.toContain("buys_scaled");
    expect(fee.notes.join(" ")).toMatch(/The buys leave room for it/);
    expect(fee.totals!.bought + fee.totals!.fxFee).toBeLessThanOrEqual(2000);
    // 2200 under: scaled, and never said as 100%.
    const short = planRebalance("demo", account, valued, [{ ticker: "SPY", weight: 0.3 }]);
    expect(short.notes.join(" ")).toMatch(/Buys are scaled to 90% because/);
  });

  it("charges no fee on pence in a pound account and says only the cash is net of it on a sell", () => {
    const pounds = { currency: "GBP", totalValue: 10_000, cash: { availableToTrade: 2000 } };
    const plan = planRebalance("demo", pounds, [held("VUSA", 80, 75, "GBX")], [{ ticker: "VUSA", weight: 0.5 }], {}, () => "GBX");
    expect(plan.totals).toMatchObject({ converted: 0, fxFee: 0 });
    expect(plan.noteDetails?.map((note) => note.code)).not.toContain("fx_fee");
    // Selling a dollar holding down, with no buy: the note does not speak of buys.
    const dollars: Position[] = [{ ...held("SPY", 10, 500, "USD"), walletImpact: { currency: "EUR", currentValue: 4000 } }];
    const sold = planRebalance("demo", account, dollars, [{ ticker: "SPY", weight: 0.2 }], { sellUntargeted: true, quantityDecimals: 0 });
    expect(sold.trades.map((trade) => [trade.side, trade.ticker])).toEqual([["sell", "SPY"]]);
    expect(sold.notes.join(" ")).toMatch(/none on a trade paid from or into a balance in that currency\. The cash after is net of it\./);
    expect(sold.cashAfter).toBe(Math.round((2000 + sold.totals!.sold - sold.totals!.fxFee) * 100) / 100);
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

  it("trades only the targets further off than the band and says how many it leaves", () => {
    // EQ is 8 points over its 52% and BOND 2 over its 18%: a 5-point band trades EQ alone.
    const targets = [{ ticker: "EQ", weight: 0.52 }, { ticker: "BOND", weight: 0.18 }];
    const full = planRebalance("demo", account, positions, targets, { cashWeight: 0.3, quantityDecimals: 0 });
    expect(full.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["sell", "EQ", 8], ["sell", "BOND", 4]]);
    const banded = planRebalance("demo", account, positions, targets, { cashWeight: 0.3, quantityDecimals: 0, band: 0.05 });
    expect(banded.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["sell", "EQ", 8]]);
    expect(banded.band).toBe(0.05);
    expect(banded.noteDetails?.find((note) => note.code === "within_band")).toEqual({
      code: "within_band", message: "Only the targets more than 5 points off their weight are traded; 1 of 2 is left as it is.", details: { count: 1, total: 2, band: 0.05 },
    });
    expect(full.noteDetails?.map((note) => note.code)).not.toContain("within_band");
  });

  it("trades nothing when every target is within the band, without calling it the minimum trade", () => {
    const plan = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.52 }, { ticker: "BOND", weight: 0.18 }], { cashWeight: 0.3, band: 0.1 });
    expect(plan.trades).toEqual([]);
    expect(plan.notes[0]).toBe("Every target is within 10 points of its weight, so nothing is traded.");
    expect(plan.noteDetails?.map((note) => note.code)).not.toContain("within_threshold");
  });

  it("funds the buys over the band from its sells and the spare cash, and keeps holdings without a target within it", () => {
    // EQ 10 points over its 50% pays for NEW, 6 points under its 6%; BOND, 1 point under, stays.
    const plan = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.5 }, { ticker: "BOND", weight: 0.21 }, { ticker: "NEW", weight: 0.06, referencePrice: 10 }], { cashWeight: 0.2, quantityDecimals: 0, band: 0.05 }, () => "EUR");
    expect(plan.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["sell", "EQ", 10], ["buy", "NEW", 60]]);
    expect(plan.cashAfter).toBe(2400);
    // A holding without a target is sold only when its whole weight is over the band.
    expect(planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.6 }], { sellUntargeted: true, band: 0.25 }).trades).toEqual([]);
    expect(planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.6 }], { sellUntargeted: true, band: 0.1 }).trades[0]).toMatchObject({ ticker: "BOND", side: "sell", quantity: 40 });
  });

  it("ignores the band when only investing cash, and refuses one outside 0 to 1", () => {
    const plan = planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.62 }, { ticker: "BOND", weight: 0.3 }], { buyOnly: true, band: 0.05, quantityDecimals: 0 });
    expect(plan.band).toBeUndefined();
    expect(plan.trades.map((trade) => trade.ticker).sort()).toEqual(["BOND", "EQ"]);
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.5 }], { band: 0 })).toThrow(/band must be/);
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.5 }], { band: 1 })).toThrow(/band must be/);
  });

  it("rejects targets above 100% and duplicates", () => {
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.8 }, { ticker: "BOND", weight: 0.3 }])).toThrow(/exceed 100%/);
    expect(() => planRebalance("demo", account, positions, [{ ticker: "EQ", weight: 0.3 }, { ticker: "eq", weight: 0.3 }])).toThrow(/more than once/);
  });
});
