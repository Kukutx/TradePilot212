import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, credentialStatus } from "./config.js";
import { SAMPLE_BASE_URL } from "./sample-broker.js";
import { MemoryStateStore } from "./state-store.js";

describe("sample data mode", () => {
  it("never uses Trading 212 or Live keys", () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", T212_LIVE_API_KEY: "real", T212_LIVE_API_SECRET: "real", DEFAULT_TRADING_ENV: "live", QUOTE_PROVIDER: "finnhub", QUOTE_API_KEY: "k" });
    expect(config.trading212.demo.baseUrl).toBe(SAMPLE_BASE_URL);
    expect(config.trading212.live.apiKey).toBe("");
    expect(config.defaultTradingEnvironment).toBe("demo");
    expect(config.quoteProvider).toBe("none");
    expect(credentialStatus(config)).toEqual({ demo: true, live: false, sample: true });
  });

  it("serves a working account: dashboard, analytics, pies and a filled order", async () => {
    const outside: string[] = [];
    const passthrough = (async (input: RequestInfo | URL) => {
      outside.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: passthrough });

    const dashboard = await services.trading.getDashboard("demo");
    expect(dashboard.account?.currency).toBe("EUR");
    expect(dashboard.positions.length).toBeGreaterThan(3);
    expect((await services.insights.income("demo", { to: new Date() })).byTicker.length).toBeGreaterThan(0);
    expect((await services.pies.listPies("demo")).pies.length).toBe(2);

    const before = dashboard.positions.find((position) => position.instrument.ticker === "AAPL_US_EQ")!.quantity;
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "AAPL", side: "buy", type: "market", quantity: 2 });
    const executed = await services.trading.executeOrder(preview.token);
    expect(executed.status).toBe("submitted");
    const after = await services.trading.getDashboard("demo");
    expect(after.positions.find((position) => position.instrument.ticker === "AAPL_US_EQ")!.quantity).toBe(before + 2);
    expect(after.account!.cash!.availableToTrade!).toBeLessThan(dashboard.account!.cash!.availableToTrade!);
    expect(outside).toEqual([]);
  });
});
