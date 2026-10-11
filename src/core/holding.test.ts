import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { holdingDetail } from "./holding.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
}

describe("holding detail", () => {
  it("gathers a holding's position, orders, alerts, target and the last year of fills and dividends", async () => {
    const services = sample();
    await services.alerts.create({ environment: "demo", instrument: "NVDA_US_EQ", condition: "below", price: 110 });
    await services.alerts.create({ environment: "demo", instrument: "AAPL_US_EQ", condition: "above", price: 260 });
    await services.targets.set("demo", { targets: [{ instrument: "NVDA_US_EQ", weight: 0.15 }] });
    const detail = await holdingDetail(services, "demo", "NVDA");
    expect(detail).toMatchObject({ kind: "holding", ticker: "NVDA_US_EQ", accountCurrency: "EUR", targetWeight: 0.15, instrument: { name: "NVIDIA", currencyCode: "USD" } });
    expect(detail.position?.quantity).toBe(20);
    expect(detail.weight).toBeGreaterThan(0.1);
    expect(detail.weight).toBeLessThan(0.2);
    expect(detail.orders.map((order) => order.id)).toEqual([81235]);
    expect(detail.alerts.map((alert) => alert.ticker)).toEqual(["NVDA_US_EQ"]);
    expect(detail.history?.fills.length).toBeGreaterThan(0);
    expect(detail.history?.fills.every((fill) => fill.filledAt && Date.parse(fill.filledAt) >= Date.parse(detail.history!.from))).toBe(true);
    const text = describePayload(detail);
    expect(text).toMatch(/^NVDA_US_EQ \(NVIDIA\) on DEMO, STOCK in USD/m);
    expect(text).toMatch(/Holding: NVDA_US_EQ NVIDIA: 20 @ 128\.75 USD .* of the account \(target 15%\)\./);
    expect(text).toMatch(/#81235 SELL 5 NVDA_US_EQ \(NVIDIA\) stop 118, 8\.3% below the last price 128\.75/);
    expect(text).toMatch(/NVDA_US_EQ \(NVIDIA\) below 110 USD/);
  });

  it("totals a year of dividends and lists the newest", async () => {
    const detail = await holdingDetail(sample(), "demo", "AAPL_US_EQ");
    // The sample pays Apple four quarterly dividends in the last year.
    expect(detail.history?.dividendCount).toBe(4);
    expect(detail.history?.dividends).toHaveLength(4);
    expect(detail.history?.dividendTotal).toBeCloseTo(detail.history!.dividends.reduce((sum, item) => sum + item.amount, 0), 2);
    expect(describePayload(detail)).toMatch(/Dividends since \d{4}-\d{2}-\d{2}: [\d.]+ EUR from 4 payment\(s\), last [\d.]+ EUR on \d{4}-\d{2}-\d{2}\./);
  });

  it("shows an instrument that is not held, with its open orders", async () => {
    const detail = await holdingDetail(sample(), "demo", "Tesla");
    expect(detail.ticker).toBe("TSLA_US_EQ");
    expect(detail.position).toBeUndefined();
    expect(detail.weight).toBeUndefined();
    expect(detail.orders.map((order) => order.id)).toEqual([81234]);
    expect(describePayload(detail)).toMatch(/^Not held\.$/m);
  });

  it("says which history ran out of pages, so a partial dividend total is not read as the year's", async () => {
    const services = sample();
    const cash = services.insights.cashHistory.bind(services.insights);
    services.insights.cashHistory = async (...args) => ({ ...(await cash(...args)), truncated: true });
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history).toMatchObject({ fillsTruncated: false, dividendsTruncated: true });
    const text = describePayload(detail);
    expect(text).toMatch(/older payments were not read, so the total covers only the newer part of the window\./);
    expect(text).not.toMatch(/Fills since .*more not read/);
  });

  it("shows the saved target of an instrument that is not held", async () => {
    const services = sample();
    await services.targets.set("demo", { targets: [{ instrument: "TSLA_US_EQ", weight: 0.05 }] });
    const detail = await holdingDetail(services, "demo", "TSLA_US_EQ");
    expect(detail.targetWeight).toBe(0.05);
    expect(describePayload(detail)).toMatch(/^Not held; target 5%\.$/m);
  });

  it("keeps the rest when the history cannot be read", async () => {
    const services = sample();
    services.insights.tradeHistory = async () => { throw new Error("Trading 212 rate limit reached (429)"); };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history).toBeUndefined();
    expect(detail.historyProblem).toMatch(/rate limit/);
    expect(detail.position?.quantity).toBe(12);
    expect(describePayload(detail)).toMatch(/History not read: .*rate limit/);
  });

  it("says when the account is not connected", async () => {
    const services = createServices({ config: createConfig({}), store: new MemoryStateStore() });
    await expect(holdingDetail(services, "demo", "AAPL_US_EQ")).rejects.toThrow(/credentials are not configured/);
  });
});
