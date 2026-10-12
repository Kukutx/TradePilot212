import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "../core/config.js";
import { MemoryStateStore } from "../core/state-store.js";
import { describePayload } from "../core/text-summary.js";
import type { PendingOrder, Position } from "./contracts.js";
import { isSellStop, portfolioProtection, stopOutcome, stopProtection, suggestedStop } from "./protection.js";

const position = (fields: Partial<Position> = {}): Position => ({
  instrument: { ticker: "NVDA_US_EQ", name: "NVIDIA", currencyCode: "USD" },
  quantity: 20, quantityAvailableForTrading: 15, quantityInPies: 0, averagePricePaid: 100, currentPrice: 125, ...fields,
} as Position);

describe("stop-loss protection", () => {
  it("counts only sell stops on the holding", () => {
    expect(isSellStop({ type: "STOP", side: "SELL", quantity: -5, stopPrice: 110 })).toBe(true);
    expect(isSellStop({ type: "STOP_LIMIT", quantity: -5, stopPrice: 105, limitPrice: 100 })).toBe(true);
    // A buy stop opens a position; a sell limit takes profit. Neither protects against a fall.
    expect(isSellStop({ type: "STOP", side: "BUY", quantity: 5, stopPrice: 140 })).toBe(false);
    expect(isSellStop({ type: "LIMIT", side: "SELL", quantity: -5, limitPrice: 150 })).toBe(false);
  });

  it("takes the highest stop and adds up what is still waiting, capped at the holding", () => {
    const orders: PendingOrder[] = [
      { ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -5, stopPrice: 110 },
      { ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -8, filledQuantity: -2, stopPrice: 115, limitPrice: 112 },
      { ticker: "NVDA_US_EQ", type: "LIMIT", side: "SELL", quantity: -5, limitPrice: 150 },
      { ticker: "AAPL_US_EQ", type: "STOP", side: "SELL", quantity: -3, stopPrice: 200 },
    ];
    expect(stopProtection(position(), orders)).toEqual({ ticker: "NVDA_US_EQ", stopPrice: 115, gap: -0.08, covered: 11, coverage: 0.55, orders: 2, levels: [{ stopPrice: 115, quantity: 6, limitPrice: 112 }, { stopPrice: 110, quantity: 5 }] });
    // Stops for more than the holding: the price reaches the higher one first, so the lower one goes without.
    expect(stopProtection(position({ quantity: 6 }), orders)).toMatchObject({ coverage: 1, levels: [{ stopPrice: 115, quantity: 6, limitPrice: 112 }] });
    expect(stopProtection(position({ quantity: 8 }), orders)?.levels).toEqual([{ stopPrice: 115, quantity: 6, limitPrice: 112 }, { stopPrice: 110, quantity: 2 }]);
    expect(stopProtection(position(), orders.slice(2))).toBeUndefined();
    // Fractional stops that add up to the holding cover all of it, despite binary floating point.
    const fractional = stopProtection(position({ quantity: 0.8 }), [
      { ticker: "NVDA_US_EQ", side: "SELL", quantity: -0.1, stopPrice: 110 },
      { ticker: "NVDA_US_EQ", side: "SELL", quantity: -0.7, stopPrice: 110 },
    ]);
    expect(fractional).toMatchObject({ covered: 0.8, coverage: 1, levels: [{ stopPrice: 110, quantity: 0.8 }] });
  });

  it("suggests a stop for the shares no stop covers, up to what is free to sell, at the existing stop or 8% below the last price", () => {
    expect(suggestedStop(position(), undefined)).toEqual({ quantity: 15, stopPrice: 115 });
    const partly = stopProtection(position(), [{ ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -12, stopPrice: 110 }]);
    expect(suggestedStop(position(), partly)).toEqual({ quantity: 8, stopPrice: 110 });
    // A stop the price already fell through would sell at once, so the suggestion goes back to 8% below.
    const passed = stopProtection(position(), [{ ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -12, stopPrice: 130 }]);
    expect(suggestedStop(position(), passed)).toEqual({ quantity: 8, stopPrice: 115 });
    const fully = stopProtection(position(), [{ ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -20, stopPrice: 110 }]);
    expect(suggestedStop(position(), fully)).toBeUndefined();
    expect(suggestedStop(position({ quantityAvailableForTrading: 0 }), undefined)).toBeUndefined();
    expect(suggestedStop(position({ quantity: 0.3, quantityAvailableForTrading: 0.3, currentPrice: 9175 }), stopProtection(position({ quantity: 0.3 }), [{ ticker: "NVDA_US_EQ", side: "SELL", quantity: -0.1, stopPrice: 8000 }]))).toEqual({ quantity: 0.2, stopPrice: 8000 });
  });

  it("keeps a suggested stop under 1 positive and below the price instead of rounding it to cents", () => {
    expect(suggestedStop(position({ currentPrice: 0.05 }), undefined)).toEqual({ quantity: 15, stopPrice: 0.046 });
    expect(suggestedStop(position({ currentPrice: 0.004 }), undefined)).toEqual({ quantity: 15, stopPrice: 0.00368 });
    expect(suggestedStop(position({ currentPrice: 0.0345 }), undefined)).toEqual({ quantity: 15, stopPrice: 0.03174 });
    expect(suggestedStop(position({ currentPrice: 1 }), undefined)).toEqual({ quantity: 15, stopPrice: 0.92 });
    // Another drop for the portfolio basket's dropPercent.
    expect(suggestedStop(position(), undefined, 0.1)).toEqual({ quantity: 15, stopPrice: 112.5 });
  });

  it("says what reaching the stop costs in the account currency, and nothing for a stop the price is already under", () => {
    // 20 shares at 125 valued at 2000 EUR (0.8 EUR per USD), 300 EUR up; a stop at 110 on 10 of them.
    const held = position({ walletImpact: { currentValue: 2000, unrealizedProfitLoss: 300 } });
    const guard = stopProtection(held, [{ ticker: "NVDA_US_EQ", side: "SELL", quantity: -10, stopPrice: 110 }])!;
    expect(stopOutcome(held, guard)).toEqual({ drop: 120, pnlAtStop: 30 });
    expect(stopOutcome(position({ walletImpact: { currentValue: 2000 } }), guard)).toEqual({ drop: 120 });
    expect(stopOutcome(position(), guard)).toBeUndefined();
    const above = stopProtection(held, [{ ticker: "NVDA_US_EQ", side: "SELL", quantity: -10, stopPrice: 130 }])!;
    expect(stopOutcome(held, above)).toBeUndefined();
    // Each stop sells at its own price: 5 shares from 125 to 110 and 5 to 100 lose (75 + 125) x 0.8 = 160 EUR, not 120.
    const ladder = stopProtection(held, [
      { ticker: "NVDA_US_EQ", side: "SELL", quantity: -5, stopPrice: 110 },
      { ticker: "NVDA_US_EQ", side: "SELL", quantity: -5, stopPrice: 100 },
    ])!;
    expect(stopOutcome(held, ladder)).toEqual({ drop: 160, pnlAtStop: -10 });
    // A stop-limit sells at its limit or better, so 10 shares stopped at 110 with a limit of 105 cost (125 - 105) x 10 x 0.8.
    const stopLimit = stopProtection(held, [{ ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -10, stopPrice: 110, limitPrice: 105 }])!;
    expect(stopOutcome(held, stopLimit)).toEqual({ drop: 160, pnlAtStop: -10 });
    // A limit above the stop still fills at the limit or better: (125 - 112) x 10 x 0.8.
    const highLimit = stopProtection(held, [{ ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -10, stopPrice: 110, limitPrice: 112 }])!;
    expect(stopOutcome(held, highLimit)?.drop).toBeCloseTo(104, 8);
    // A limit at or above the last price would not sell on a fall at all, so there is no outcome to show.
    const aboveLast = stopProtection(held, [{ ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -10, stopPrice: 110, limitPrice: 126 }])!;
    expect(stopOutcome(held, aboveLast)).toBeUndefined();
  });

  it("sums coverage across the portfolio in the account currency", () => {
    const amd = position({ instrument: { ticker: "AMD_US_EQ", name: "AMD", currencyCode: "USD" } as Position["instrument"], quantity: 10, quantityAvailableForTrading: 10, walletImpact: { currentValue: 1000 } });
    const nvda = position({ walletImpact: { currentValue: 3000 } });
    const stops: PendingOrder[] = [{ ticker: "NVDA_US_EQ", side: "SELL", quantity: -5, stopPrice: 110 }];
    // NVDA: 5 of 20 covered, so 2250 of its 3000 is not; AMD has no stop.
    expect(portfolioProtection([nvda, amd], stops)).toEqual({ holdings: 2, covered: 0, partial: 1, protectable: 2, unprotectedValue: 3250, unprotectedShare: 0.8125 });
    expect(portfolioProtection([nvda, amd], [...stops, { ticker: "NVDA_US_EQ", side: "SELL", quantity: -15, stopPrice: 110 }, { ticker: "AMD_US_EQ", side: "SELL", quantity: -10, stopPrice: 90 }]))
      .toEqual({ holdings: 2, covered: 2, partial: 0, protectable: 0, unprotectedValue: 0, unprotectedShare: 0 });
    // Without an account-currency value for every holding there is no total to show.
    expect(portfolioProtection([nvda, position({ instrument: amd.instrument })], stops)).not.toHaveProperty("unprotectedValue");
  });

  it("lists covered and uncovered holdings in the dashboard summary", async () => {
    const services = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const text = describePayload(await services.trading.getDashboard("demo"));
    // The sample account has one sell stop: 5 of 20 NVIDIA at 118.
    // 10.75 USD a share to the stop on 5 shares, at the 0.92 EUR the valuation implies; a quarter of the 597.08 P/L stays.
    expect(text).toMatch(/^Stop-loss orders: NVDA_US_EQ 5 of 20 \(25%\) from 118, 8\.3% below the last price; if it triggers: -49\.45 EUR from now, P\/L \+99\.82\. No stop on [A-Za-z_, ]+\.$/m);
    const dashboard = await services.trading.getDashboard("demo");
    // A second stop lower down widens the range, and its 5 shares cost from the last price down to 100.
    const ladder = describePayload({ ...dashboard, orders: [...dashboard.orders, { id: 99, ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -5, stopPrice: 100, status: "NEW" }] });
    expect(ladder).toMatch(/^Stop-loss orders: NVDA_US_EQ 10 of 20 \(50%\) from 118 down to 100, 8\.3% below the last price; if every stop triggers: -/m);
    // A stop-limit names its limit and is costed there: 5 shares from 128.75 to 115 at the 0.92 EUR rate.
    const stopLimit = describePayload({ ...dashboard, orders: [{ id: 98, ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -5, stopPrice: 118, limitPrice: 115, status: "NEW" }] });
    expect(stopLimit).toMatch(/^Stop-loss orders: NVDA_US_EQ 5 of 20 \(25%\) from 118 \(stop-limit: sells at 115 or better, or not at all after a gap\), 8\.3% below the last price; if it triggers and fills: -63\.25 EUR from now/m);
    const bare = describePayload({ ...dashboard, orders: [] });
    // With no stop anywhere, the line still names every holding without one.
    expect(bare).toMatch(/^Stop-loss orders: none\. No stop on (?=.*NVDA_US_EQ)(?=.*AAPL_US_EQ)[A-Za-z_, ]+\.$/m);
  });
});
