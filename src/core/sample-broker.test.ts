import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, credentialStatus } from "./config.js";
import { asStructuredError } from "./errors.js";
import { createSampleBroker, SAMPLE_BASE_URL } from "./sample-broker.js";
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

  it("expects the sample holdings' dividends over this month and the next 11", async () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const income = await services.insights.income("demo", { to: new Date() });
    const forward = income.forwardAnnual!;
    expect(forward.calendar).toHaveLength(12);
    // Four quarterly payers: each one's year of payments falls in the calendar or was paid this month.
    expect(new Set(forward.upcoming!.map((payment) => payment.ticker))).toEqual(new Set(["AAPL_US_EQ", "KO_US_EQ", "MSFT_US_EQ", "VUSAl_EQ"]));
    const expected = forward.calendar!.reduce((sum, month) => sum + month.expected, 0);
    expect(expected).toBeCloseTo(forward.upcoming!.reduce((sum, payment) => sum + payment.amount, 0), 1);
    expect(expected + forward.calendar![0]!.paid).toBeGreaterThan(forward.total * 0.7);
    const text = describePayload({ ...income, credentials: credentialStatus(config), writeEnabled: false });
    expect(text).toMatch(/Dividend calendar, this month and the next 11 [^\n]*:\n- \d{4}-\d{2}: (paid [\d.]+, )?expected [\d.]+/);
    expect(text).toMatch(/Next payments \(\d+, dates approximate\):\n- about \d{4}-\d{2}-\d{2}: [\w-]+ [\d.]+/);
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
    expect(history.filter).toEqual({ ticker: "MSFT_US_EQ" });
  });

  it("adds up every fill in the window, not only the ones listed", async () => {
    const services = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const all = await services.insights.tradeHistory("demo", { to: new Date() }, undefined, 200);
    const two = await services.insights.tradeHistory("demo", { to: new Date() }, undefined, 2);
    expect(two.fills).toHaveLength(2);
    expect(two).toMatchObject({ count: all.fills.length, limit: 2, totals: all.totals });
    expect(all.filter).toBeUndefined();
    const realised = all.fills.reduce((sum, fill) => sum + (fill.realisedProfitLoss ?? 0), 0);
    expect(all.totals.realised).toBeCloseTo(realised, 2);
    expect(all.totals.buys + all.totals.sells).toBe(all.fills.length);
    expect(all.totals.currency).toBe("EUR");
    // The text the model reads gives the same totals, and says only the newest are listed.
    const text = describePayload(two);
    expect(text).toContain(`Totals over all ${all.fills.length} fill(s) (EUR): ${all.totals.buys} buys`);
    expect(text).toContain(`The newest 2 of ${all.fills.length} fills are listed`);
  });

  it("holds back the shares a pending sell covers, as Trading 212 does", async () => {
    const broker = createSampleBroker((async () => new Response("{}")) as typeof fetch);
    const call = async (path: string, init?: RequestInit) => (await broker(`${SAMPLE_BASE_URL}${path}`, init)).json() as Promise<Record<string, unknown>>;
    const nvidia = async () => ((await call("/equity/positions")) as unknown as Array<{ instrument: { ticker: string }; quantityAvailableForTrading: number }>).find((item) => item.instrument.ticker === "NVDA_US_EQ")!;
    // 20 shares, 4 in pies, 5 under the sample stop-loss.
    expect((await nvidia()).quantityAvailableForTrading).toBe(11);
    const sell = (quantity: number) => broker(`${SAMPLE_BASE_URL}/equity/orders/limit`, { method: "POST", body: JSON.stringify({ ticker: "NVDA_US_EQ", quantity: -quantity, limitPrice: 140, timeValidity: "DAY" }) });
    expect(await (await sell(12)).json()).toMatchObject({ code: "SellingEquityNotOwned" });
    expect((await sell(11)).ok).toBe(true);
    expect((await nvidia()).quantityAvailableForTrading).toBe(0);
    await broker(`${SAMPLE_BASE_URL}/equity/orders/81235`, { method: "DELETE" });
    expect((await nvidia()).quantityAvailableForTrading).toBe(5);
  });

  it("keeps a holding's cost, result and exchange-rate part together as it trades, a new one at today's rate", async () => {
    const broker = createSampleBroker((async () => new Response("{}")) as typeof fetch);
    type Wallet = { totalCost: number; currentValue: number; unrealizedProfitLoss: number; fxImpact: number };
    const holding = async (ticker: string) => ((await (await broker(`${SAMPLE_BASE_URL}/equity/positions`)).json()) as Array<{ instrument: { ticker: string }; quantity: number; averagePricePaid: number; currentPrice: number; walletImpact: Wallet }>)
      .find((item) => item.instrument.ticker === ticker);
    const buy = (ticker: string, quantity: number) => broker(`${SAMPLE_BASE_URL}/equity/orders/market`, { method: "POST", body: JSON.stringify({ ticker, quantity }) });
    // Bought at 0.95 EUR a dollar, worth 0.92 today: 12 × 168.40 × -0.03.
    expect((await holding("AAPL_US_EQ"))!.walletImpact.fxImpact).toBe(-60.62);
    const before = (await holding("AAPL_US_EQ"))!.walletImpact;
    expect((await buy("AAPL_US_EQ", 2)).ok).toBe(true);
    const after = (await holding("AAPL_US_EQ"))!;
    // The buy at today's rate adds its cost and nothing on the rate; the price part is the price's move at today's rate.
    expect(after.walletImpact.totalCost).toBeCloseTo(before.totalCost + 2 * 231.55 * 0.92, 1);
    expect(after.walletImpact.fxImpact).toBeCloseTo(before.fxImpact, 1);
    expect(after.walletImpact.unrealizedProfitLoss - after.walletImpact.fxImpact).toBeCloseTo(after.quantity * (after.currentPrice - after.averagePricePaid) * 0.92, 1);
    expect((await buy("TSLA_US_EQ", 1)).ok).toBe(true);
    expect((await holding("TSLA_US_EQ"))!.walletImpact).toMatchObject({ fxImpact: 0, unrealizedProfitLoss: 0 });
    // The account's result is the holdings' results.
    const account = await (await broker(`${SAMPLE_BASE_URL}/equity/account/summary`)).json() as { investments: { unrealizedProfitLoss: number } };
    const positions = await (await broker(`${SAMPLE_BASE_URL}/equity/positions`)).json() as Array<{ walletImpact: Wallet }>;
    expect(account.investments.unrealizedProfitLoss).toBeCloseTo(positions.reduce((sum, item) => sum + item.walletImpact.unrealizedProfitLoss, 0), 1);
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
    expect(deposits.filter).toEqual({ types: ["DEPOSIT"] });
    expect(coke.filter).toEqual({ ticker: "KO_US_EQ" });
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
