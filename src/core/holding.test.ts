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
    // Not held, its price comes from the quote provider: the sample account's own, offline.
    expect(detail.quote).toMatchObject({ price: 244.1, source: "sample", symbol: "TSLA" });
    expect(describePayload(detail)).toMatch(/^Not held; price 244\.1 USD \(simulated for the sample account\)\.$/m);
    // And the simulated closes end at that price.
    expect(detail.prices?.points.at(-1)?.close).toBe(244.1);
  });

  it("leaves the quote out of a holding's page, and says so when the provider gives none", async () => {
    const held = await holdingDetail(sample(), "demo", "NVDA");
    expect(held.quote).toBeUndefined();
    const services = sample();
    const quiet = { ...services, trading: Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, { externalQuote: async () => undefined }) };
    const detail = await holdingDetail(quiet, "demo", "TSLA");
    expect(detail.quote).toBeUndefined();
    expect(detail).toMatchObject({ pricesMissing: "sample" });
    expect(describePayload(detail)).toMatch(/^Not held\.$/m);
  });

  it("adds a year of daily closes that pass through the fills, and sums them up in the text", async () => {
    const detail = await holdingDetail(sample(), "demo", "NVDA_US_EQ");
    const points = detail.prices!.points;
    expect(detail.prices?.source).toBe("sample");
    expect(points.length).toBeGreaterThan(250);
    expect(points.at(-1)?.close).toBe(128.75);
    for (const fill of detail.history!.fills) {
      const day = points.filter((point) => point.date <= fill.filledAt!.slice(0, 10)).at(-1);
      expect(day?.close).toBeCloseTo(fill.price!, 2);
    }
    expect(describePayload(detail)).toMatch(/^Daily closes \(simulated for the sample account\) \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}: [\d.]+ to 128\.75 USD \([+-][\d.]+%\); 1M [+-][\d.]+%, 3M [+-][\d.]+%, 6M [+-][\d.]+%; high [\d.]+ on \d{4}-\d{2}-\d{2}, low [\d.]+ on \d{4}-\d{2}-\d{2}\.$/m);
  });

  it("lists the newest 20 fills and gives the chart the older ones with only what a mark needs", async () => {
    const services = sample();
    const trades = services.insights.tradeHistory.bind(services.insights);
    services.insights.tradeHistory = async (...args) => {
      const read = await trades(...args);
      const one = read.fills[0]!;
      const fills = Array.from({ length: 26 }, (_, index) => ({ ...one, orderId: String(500 + index), filledAt: new Date(Date.parse(one.filledAt!) - index * 7 * 86_400_000).toISOString(), quantity: index % 5 === 4 ? -1 : 1 }));
      return { ...read, fills };
    };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history?.fills).toHaveLength(20);
    expect(detail.history?.olderFills).toHaveLength(6);
    expect(detail.history?.olderFills?.[4]).toEqual({ filledAt: expect.any(String), side: "SELL", quantity: 1, price: expect.any(Number) });
    expect(describePayload(detail)).toMatch(/Fills since \d{4}-\d{2}-\d{2} \(newest 20 of 26\)/);
  });

  it("keeps the rest when the daily closes cannot be read", async () => {
    const services = { ...sample(), priceHistory: async () => { throw new Error("quote provider down"); } };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail).toMatchObject({ pricesMissing: "data", pricesProblem: "quote provider down" });
    expect(detail.history?.fills.length).toBeGreaterThan(0);
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
    expect(describePayload(detail)).toMatch(/^Not held; price 244\.1 USD \(simulated for the sample account\); target 5%\.$/m);
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
