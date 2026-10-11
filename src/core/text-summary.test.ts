import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
}

describe("text summaries for hosts that only show text", () => {
  it("lists the account and every holding", async () => {
    const services = sample();
    const dashboard = await services.trading.getDashboard("demo");
    const text = describePayload(dashboard);
    expect(text).toMatch(/EUR/);
    for (const position of dashboard.positions.slice(0, 5)) expect(text).toContain(position.instrument.ticker);
  });

  it("gives an order preview's amount in the account currency and says when the token may be used", async () => {
    const services = sample();
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "AAPL", side: "buy", type: "limit", quantity: 1, limitPrice: 200, timeValidity: "DAY" });
    const text = describePayload(preview);
    expect(text).toMatch(/Ready to send to DEMO: buy 1 AAPL_US_EQ/i);
    expect(text).toMatch(/\(about [\d.,]+ EUR\)/);
    expect(text).toContain(`Confirmation token ${preview.token}`);
    expect(text).toMatch(/only after the user explicitly says to/);
  });

  it("describes orders placed by amount and the quantity cap", async () => {
    const services = sample();
    const dashboard = await services.trading.getDashboard("demo");
    const text = describePayload({ ...dashboard, orders: [{ id: 7, ticker: "VUSA_EQ", strategy: "VALUE", value: 250, currency: "EUR", type: "MARKET", status: "NEW" }] });
    expect(text).toContain("#7 BUY value 250 EUR of VUSA_EQ market (NEW)");
    const config = createConfig({ MAX_ORDER_QUANTITY: "50" });
    const policy = describePayload({ kind: "trading_policy", environment: "demo", policy: config.policy.demo, maxOrderNotional: config.maxOrderNotional, maxOrderQuantity: config.maxOrderQuantity, usageToday: { orders: 0, notional: 0 } });
    expect(policy).toContain("quantity 50 shares");
  });

  it("returns nothing for payloads the summary already covers", () => {
    expect(describePayload({ kind: "unknown" })).toBe("");
    expect(describePayload(null)).toBe("");
  });
});
