import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, credentialStatus } from "./config.js";
import { asStructuredError } from "./errors.js";
import { SAMPLE_BASE_URL } from "./sample-broker.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

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

  it("holds cash for a pending buy and releases it on cancel", async () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const before = (await services.trading.getDashboard("demo")).account!;
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "MSFT", side: "buy", type: "limit", quantity: 1, limitPrice: 400, timeValidity: "DAY" });
    expect((await services.trading.executeOrder(preview.token)).status).toBe("submitted");
    const placed = await services.trading.getDashboard("demo");
    expect(placed.account!.cash!.availableToTrade).toBeCloseTo(before.cash!.availableToTrade! - 368, 2);
    expect(placed.account!.totalValue).toBeCloseTo(before.totalValue!, 2);
    const order = placed.orders.find((item) => item.ticker === "MSFT_US_EQ")!;
    const cancel = await services.trading.prepareCancel("demo", String(order.id));
    await services.trading.executeCancel(cancel.token);
    const cancelled = (await services.trading.getDashboard("demo")).account!;
    expect(cancelled.cash!.availableToTrade).toBeCloseTo(before.cash!.availableToTrade!, 2);
    expect(cancelled.totalValue).toBeCloseTo(before.totalValue!, 2);

    // The cancelled order shows in the history for that instrument, without a fill.
    const history = await services.insights.tradeHistory("demo", { to: new Date() }, "Microsoft", 50, undefined, true);
    expect(history.unfilled).toEqual([expect.objectContaining({ ticker: "MSFT_US_EQ", status: "CANCELLED", limitPrice: 400 })]);
    expect(history.fills.every((fill) => fill.ticker === "MSFT_US_EQ")).toBe(true);
    expect((await services.insights.tradeHistory("demo", { to: new Date() }, "MSFT")).unfilled).toBeUndefined();
  });

  it("reports one order's state and lists dividends and cash movements", async () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const { trading, insights } = services;
    expect((await trading.orderStatus("demo", "81234")).state).toBe("open");
    const bought = await trading.executeOrder((await trading.prepareOrder({ environment: "demo", ticker: "KO", side: "buy", type: "market", quantity: 2, referencePrice: 62 })).token);
    const filledId = String((bought.order as { id: number }).id);
    const filled = await trading.orderStatus("demo", filledId);
    expect(filled).toMatchObject({ state: "filled", orderId: filledId });
    expect(describePayload(filled)).toMatch(/Filled 2 at an average/);
    await trading.executeCancel((await trading.prepareCancel("demo", "81234")).token);
    expect((await trading.orderStatus("demo", "81234")).state).toBe("cancelled");
    expect((await trading.orderStatus("demo", "999999")).state).toBe("not_found");
    await expect(trading.orderStatus("demo", "abc")).rejects.toThrow(/numeric/);

    const year = { from: new Date(Date.now() - 365 * 86_400_000), to: new Date() };
    const coke = await insights.cashHistory("demo", year, { ticker: "Coca-Cola" });
    expect(coke.items.length).toBeGreaterThan(0);
    expect(coke.items.every((item) => item.type === "DIVIDEND" && item.ticker === "KO_US_EQ")).toBe(true);
    const deposits = await insights.cashHistory("demo", { to: new Date() }, { types: ["deposit"] });
    expect(deposits.totals).toEqual({ DEPOSIT: 14_000 });
    expect(describePayload(deposits)).toContain("deposit +14000");
  });

  it("names the instruments on the automation page and says which accounts are set up", async () => {
    const services = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    await services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "below", price: 8_500 });
    const overview = await services.automationOverview("demo");
    expect(overview.instruments).toEqual([{ ticker: "VUSAl_EQ", name: "Vanguard S&P 500 UCITS ETF (Dist)", shortName: "VUSA", currencyCode: "GBX", type: "ETF" }]);
    expect(describePayload(overview)).toContain("VUSAl_EQ (Vanguard S&P 500 UCITS ETF (Dist)) below 8500 GBX");
    const trailing = await services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "trailing_drop", percent: 5 });
    expect(describePayload({ ...overview, alerts: [{ ...trailing, lastPrice: 9175 }] })).toContain("trailing drop 5% (" );
    expect(describePayload({ ...overview, alerts: [{ ...trailing, lastPrice: 9175 }] })).toContain("last 9175 GBX");
    expect((await services.automationOverview("live")).instruments).toBeUndefined();

    const missing = await services.insights.allocation("live").catch((error: unknown) => error);
    expect(asStructuredError(missing)).toMatchObject({ code: "CREDENTIALS_NOT_CONFIGURED", details: { environment: "live", demo: true, live: false } });
  });
});
