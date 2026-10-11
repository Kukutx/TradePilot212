import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "../core/config.js";
import { MemoryStateStore } from "../core/state-store.js";
import { describePayload } from "../core/text-summary.js";
import type { PendingOrder, Position } from "./contracts.js";
import { isSellStop, stopProtection } from "./protection.js";

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
    expect(stopProtection(position(), orders)).toEqual({ ticker: "NVDA_US_EQ", stopPrice: 115, gap: -0.08, covered: 11, coverage: 0.55, orders: 2 });
    expect(stopProtection(position({ quantity: 6 }), orders)?.coverage).toBe(1);
    expect(stopProtection(position(), orders.slice(2))).toBeUndefined();
  });

  it("lists covered and uncovered holdings in the dashboard summary", async () => {
    const services = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const text = describePayload(await services.trading.getDashboard("demo"));
    // The sample account has one sell stop: 5 of 20 NVIDIA at 118.
    expect(text).toMatch(/^Stop-loss orders: NVDA_US_EQ 5 of 20 \(25%\) from 118, 8\.3% below the last price\. No stop on [A-Za-z_, ]+\.$/m);
  });
});
