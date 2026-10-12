import { describe, expect, it } from "vitest";
import type { Instrument, OrderDraft } from "../shared/contracts.js";
import { createConfig, type RuntimeConfig } from "./config.js";
import type { QuoteProvider } from "./quotes.js";
import { MemoryStateStore } from "./state-store.js";
import { resolveInstrumentFromList, riskNotices, TradingService, validateOrderAgainstSnapshot } from "./trading-service.js";

const instrument: Instrument = {
  ticker: "AAPL_US_EQ",
  name: "Apple Inc.",
  shortName: "AAPL",
  currencyCode: "USD",
  maxOpenQuantity: 10,
  extendedHours: true,
};
const draft: OrderDraft = { environment: "demo", ticker: instrument.ticker, side: "buy", type: "market", quantity: 2, referencePrice: 100 };

describe("instrument resolution", () => {
  it("prefers the underlying stock when a company name also matches derivative ETFs", () => {
    const stock: Instrument = { ...instrument, name: "Apple Inc.", type: "STOCK" };
    const derivative: Instrument = {
      ticker: "AAPYd_EQ",
      name: "IncomeShares Apple AAPL Options (Dist)",
      shortName: "AAPY",
      currencyCode: "EUR",
      type: "ETF",
    };
    const europeanListing: Instrument = {
      ticker: "APCd_EQ",
      name: "Apple Inc.",
      shortName: "APC",
      currencyCode: "EUR",
      type: "STOCK",
    };
    expect(resolveInstrumentFromList([derivative, europeanListing, stock], "Apple Inc.").ticker).toBe("AAPL_US_EQ");
    expect(resolveInstrumentFromList([derivative, stock], "Apple").ticker).toBe("AAPL_US_EQ");
  });

  it("resolves an ISIN and lists the listings when it trades on several exchanges", () => {
    const listing = (ticker: string, currencyCode: string): Instrument => ({ ticker, name: "Vanguard S&P 500", shortName: "VUSA", currencyCode, type: "ETF", isin: "IE00B3XXRP09" });
    expect(resolveInstrumentFromList([listing("VUSAl_EQ", "GBP")], "ie00b3xxrp09").ticker).toBe("VUSAl_EQ");
    expect(() => resolveInstrumentFromList([listing("VUSAl_EQ", "GBP"), listing("VUSAa_EQ", "EUR")], "IE00B3XXRP09")).toThrow(/VUSAl_EQ \(GBP\), VUSAa_EQ \(EUR\)/);
  });
});

describe("trade safety", () => {
  it("enforces cash and notional limits", () => {
    expect(() => validateOrderAgainstSnapshot(draft, instrument, undefined, { currency: "USD", cash: { availableToTrade: 150 } }, { maxOrderNotional: 500, maxOrderQuantity: 10 })).toThrow(/available cash/i);
    expect(() => validateOrderAgainstSnapshot(draft, instrument, undefined, { currency: "USD", cash: { availableToTrade: 1000 } }, { maxOrderNotional: 150, maxOrderQuantity: 10 })).toThrow(/MAX_ORDER_NOTIONAL/);
  });

  it("prevents selling more than the current tradable position", () => {
    expect(() => validateOrderAgainstSnapshot(
      { ...draft, side: "sell", quantity: 2 },
      instrument,
      { instrument, quantity: 2, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 },
      { currency: "USD" },
      { maxOrderNotional: 500, maxOrderQuantity: 10 },
    )).toThrow(/available quantity/i);
  });

  it("does not let an understated Market reference price bypass the notional cap", () => {
    const position = { instrument, quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 90, currentPrice: 400 };
    expect(() => validateOrderAgainstSnapshot(
      { ...draft, quantity: 2, referencePrice: 1 },
      instrument,
      position,
      { currency: "USD", cash: { availableToTrade: 10_000 } },
      { maxOrderNotional: 500, maxOrderQuantity: 10 },
    )).toThrow(/MAX_ORDER_NOTIONAL/);
  });

  it("allows self-hosters to disable app-level caps with zero", () => {
    const result = validateOrderAgainstSnapshot(
      { environment: "demo", ticker: instrument.ticker, side: "buy", type: "market", quantity: 2 },
      { ...instrument, maxOpenQuantity: undefined },
      undefined,
      { currency: "EUR", cash: { availableToTrade: 1000 } },
      { maxOrderNotional: 0, maxOrderQuantity: 0 },
    );
    expect(result.estimatedNotional).toBeUndefined();
    expect(result.cashCheckApplied).toBe(false);
  });
});

function config(): RuntimeConfig {
  return {
    publicBaseUrl: "https://example.test",
    loginPassword: "0123456789abcdef",
    signingSecret: "0123456789abcdef0123456789abcdef",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    confirmationTtlSeconds: 90,
    maxOrderNotional: 5000,
    maxOrderQuantity: 100000,
    defaultTradingEnvironment: "demo",
    policy: createConfig({}).policy,
    demoAutomationEnabled: false,
    protectiveLinking: true,
    orderWatch: true,
    notifyWebhookUrl: "",
    notifyWebhookSecret: "",
    notifyEvents: [],
    quoteProvider: "none",
    quoteApiKey: "",
    quoteSymbols: new Map(),
    sampleData: false,
    oauthRedirectHosts: [],
    trading212: {
      demo: { baseUrl: "https://demo.test", apiKey: "key", apiSecret: "secret" },
      live: { baseUrl: "https://live.test", apiKey: "key", apiSecret: "secret" },
    },
  };
}

function fakeFetch(): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.endsWith("/equity/metadata/instruments")
      ? [instrument]
      : url.endsWith("/equity/positions")
        ? [{ instrument, quantity: 2, quantityAvailableForTrading: 1.6, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100, walletImpact: { currentValue: 185.19 } }]
        : url.endsWith("/equity/account/summary")
          ? { currency: "EUR", cash: { availableToTrade: 1000 } }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("flexible order intent", () => {
  it("resolves a company name and sells a percentage of the total held position", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "Apple Inc.",
      side: "sell",
      type: "market",
      sizing: { mode: "position_percent", percent: 50 },
    });
    expect(resolved.draft.ticker).toBe("AAPL_US_EQ");
    expect(resolved.draft.quantity).toBe(1);
    expect(resolved.draft.referencePrice).toBe(100);
    expect(resolved.availableToSell).toBe(1.6);
  });

  it("does not silently reinterpret a held-position percentage as a percentage of only tradable shares", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    await expect(service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL",
      side: "sell",
      type: "market",
      sizing: { mode: "position_percent", percent: 90 },
    })).rejects.toThrow(/only 1\.6 are currently tradable/i);
  });

  it("converts a target amount to quantity using an explicit FX rate and reference price", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL",
      side: "buy",
      type: "market",
      sizing: { mode: "notional", amount: 100, currency: "EUR", fxRateToInstrumentCurrency: 1.1 },
      referencePrice: 220,
    });
    expect(resolved.draft.quantity).toBe(0.5);
    expect(resolved.requestedNotional).toBe(100);
    expect(resolved.requestedNotionalCurrency).toBe("EUR");
    expect(resolved.estimatedQuoteNotional).toBe(110);
  });

  it("sizes a buy from a percentage of available cash", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL",
      side: "buy",
      type: "market",
      sizing: { mode: "cash_percent", percent: 20, fxRateToInstrumentCurrency: 1.1 },
      referencePrice: 220,
    });
    expect(resolved.requestedNotional).toBe(200);
    expect(resolved.requestedNotionalCurrency).toBe("EUR");
    expect(resolved.draft.quantity).toBe(1);
  });

  it("supports selling all available shares", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL_US_EQ",
      side: "sell",
      type: "market",
      sizing: { mode: "all_available" },
    });
    expect(resolved.draft.quantity).toBe(1.6);
  });

  it("records reviewed orders and returns structured freshness notices", async () => {
    const store = new MemoryStateStore();
    const service = new TradingService({ config: config(), store, fetcher: fakeFetch() });
    const preview = await service.prepareOrder({
      environment: "demo",
      ticker: "AAPL_US_EQ",
      side: "sell",
      type: "market",
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(preview.snapshotAt).toBeTruthy();
    expect(preview.notices.map((notice) => notice.code)).toContain("REFERENCE_PRICE_STALE");
    expect(preview.notices.map((notice) => notice.code)).toContain("MARKET_SLIPPAGE");
    const activity = await service.getActivity("demo");
    expect(activity[0]?.type).toBe("order_prepared");
    expect(activity[0]?.ticker).toBe("AAPL_US_EQ");
    expect(activity[0]?.quantity).toBe(1);
  });

  it("warns that a Market order placed while the market is closed will be queued", async () => {
    const service = new TradingService({
      config: config(), store: new MemoryStateStore(), fetcher: fakeFetch(),
      marketStatus: async () => ({ ticker: "AAPL_US_EQ", session: "closed", isOpen: false, nextOpen: "2026-10-12T13:30:00.000Z", checkedAt: new Date().toISOString() }),
    });
    const preview = await service.prepareOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "market", quantity: 1, referencePrice: 100 });
    const notice = preview.notices.find((item) => item.code === "MARKET_CLOSED_QUEUED");
    expect(notice?.details?.nextOpen).toBe("2026-10-12T13:30:00.000Z");
  });

  it("flags a stale FX timestamp when cross-currency sizing metadata is present", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const preview = await service.prepareOrder({
      environment: "demo",
      ticker: "AAPL_US_EQ",
      side: "buy",
      type: "market",
      quantity: 0.5,
      referencePrice: 100,
      referencePriceAt: new Date().toISOString(),
      fxRateAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(preview.notices.map((notice) => notice.code)).toContain("CROSS_CURRENCY_FUNDS_CHECK");
    expect(preview.notices.map((notice) => notice.code)).toContain("FX_RATE_STALE");
  });

  it("verifies an uncertain market order without retrying the write", async () => {
    const store = new MemoryStateStore();
    const service = new TradingService({ config: config(), store, fetcher: fakeFetch() });
    await store.put("verify:test-order", {
      kind: "order",
      environment: "demo",
      draft: { environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 100 },
      baselineQuantity: 1,
      createdAt: new Date().toISOString(),
    });

    const result = await service.verifyExecution("test-order");
    expect(result.status).toBe("likely_executed");
    expect(result.positionDelta).toBe(1);
    const activity = await service.getActivity("demo");
    expect(activity.some((event) => event.type === "order_verification" && event.outcome === "likely_executed")).toBe(true);
  });

});

/** A fake Trading 212 with a GBX ETF and a USD stock in a EUR account, valued as the broker values them. */
function fxFetch(options: { writeBody?: () => BodyInit; writes?: string[]; unheld?: boolean } = {}): typeof fetch {
  const vusa: Record<string, unknown> = { ticker: "VUSAl_EQ", name: "Vanguard S&P 500 (Dist)", shortName: "VUSA", currency: "GBX", type: "ETF" };
  const aapl: Record<string, unknown> = { ticker: "AAPL_US_EQ", name: "Apple Inc.", shortName: "AAPL", currency: "USD", type: "STOCK" };
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST" || init?.method === "DELETE") {
      options.writes?.push(`${init.method} ${new URL(url).pathname}`);
      return new Response(options.writeBody?.() ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/equity/metadata/instruments")) return json([{ ...vusa, currencyCode: "GBX" }, { ...aapl, currencyCode: "USD" },
      ...(options.unheld ? [{ ticker: "MSFT_US_EQ", name: "Microsoft", shortName: "MSFT", currencyCode: "USD", type: "STOCK" }] : [])]);
    // The positions endpoint names the currency `currency`, not `currencyCode`.
    if (url.endsWith("/equity/positions")) return json([
      { instrument: vusa, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 8000, currentPrice: 8475, walletImpact: { currency: "EUR", currentValue: 1000 } },
      { instrument: aapl, quantity: 5, quantityAvailableForTrading: 5, quantityInPies: 0, averagePricePaid: 200, currentPrice: 216, walletImpact: { currency: "EUR", currentValue: 1000 } },
    ]);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 3000, cash: { availableToTrade: 1000 } });
    if (/\/equity\/orders\/\d+$/.test(url)) return json({ id: 42, ticker: "AAPL_US_EQ", quantity: -5, type: "STOP", stopPrice: 190, status: "NEW" });
    return json([]);
  }) as typeof fetch;
}

describe("currencies, uncertain results and Live confirmations", () => {
  it("reads the position currency Trading 212 reports and values holdings in the account currency", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    const dashboard = await service.getDashboard("demo");
    expect(dashboard.positions.map((position) => position.instrument.currencyCode)).toEqual(["GBX", "USD"]);
  });

  it("sizes a cross-currency amount from the rates implied by the holdings", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    // 1000 EUR of VUSA is 10 × 8475 GBX, so 1 EUR = 84.75 GBX; 100 EUR buys 8475 GBX of shares.
    const vusa = await service.resolveOrderIntent({ environment: "demo", instrument: "VUSAl_EQ", side: "buy", type: "market", sizing: { mode: "notional", amount: 100, currency: "EUR" } });
    expect(vusa.draft.quantity).toBe(1);
    expect(vusa.note).toMatch(/implied by your holdings/);
    const apple = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", sizing: { mode: "cash_percent", percent: 10 } });
    expect(apple.draft.quantity).toBe(0.5);
  });

  it("applies MAX_ORDER_NOTIONAL in the account currency, not in pence", () => {
    const etf: Instrument = { ticker: "VUSAl_EQ", name: "Vanguard S&P 500", shortName: "VUSA", currencyCode: "GBX" };
    const order = (quantity: number): OrderDraft => ({ environment: "demo", ticker: etf.ticker, side: "buy", type: "market", quantity, referencePrice: 8475 });
    const account = { currency: "EUR", cash: { availableToTrade: 10_000 } };
    const rates = { EUR: 1, GBX: 84.75 };
    // 5 shares are 42,375 GBX but only 500 EUR.
    expect(validateOrderAgainstSnapshot(order(5), etf, undefined, account, { maxOrderNotional: 600, maxOrderQuantity: 0 }, rates).accountNotional).toBeCloseTo(500, 6);
    expect(() => validateOrderAgainstSnapshot(order(10), etf, undefined, account, { maxOrderNotional: 600, maxOrderQuantity: 0 }, rates)).toThrow(/1000\.00 EUR exceeds MAX_ORDER_NOTIONAL/);
  });

  it("never compares an amount in another currency with the cap as is", () => {
    const msft: Instrument = { ticker: "MSFT_US_EQ", name: "Microsoft", shortName: "MSFT", currencyCode: "USD" };
    const order = (quantity: number, fxRate?: number): OrderDraft => ({ environment: "demo", ticker: msft.ticker, side: "buy", type: "market", quantity, referencePrice: 100, ...(fxRate ? { fxRate } : {}) });
    const account = { currency: "PLN", cash: { availableToTrade: 100_000 } };
    const caps = { maxOrderNotional: 5000, maxOrderQuantity: 0 };
    // 4000 USD would pass a 5000 cap compared as is, but it is 16,000 PLN.
    expect(() => validateOrderAgainstSnapshot(order(40), msft, undefined, account, caps)).toThrow(/No PLN to USD exchange rate is known/);
    expect(() => validateOrderAgainstSnapshot(order(40, 0.25), msft, undefined, account, caps)).toThrow(/16000\.00 PLN exceeds MAX_ORDER_NOTIONAL/);
    expect(validateOrderAgainstSnapshot(order(10, 0.25), msft, undefined, account, caps).accountNotional).toBeCloseTo(4000, 6);
    // The broker's valuation of a holding wins over a rate passed with the order.
    expect(validateOrderAgainstSnapshot(order(10, 0.25), msft, undefined, account, caps, { PLN: 1, USD: 0.5 }).accountNotional).toBeCloseTo(2000, 6);
    // With the cap off there is nothing to compare, so no rate is needed.
    expect(validateOrderAgainstSnapshot(order(40), msft, undefined, account, { maxOrderNotional: 0, maxOrderQuantity: 0 }).accountNotional).toBeUndefined();
  });

  it("sizes a buy by what it would lose at the stop-loss, in the account currency", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    // 1% of the 3000 EUR account is 30 EUR, or 32.40 USD at the 1.08 the AAPL holding implies; 216 down to 200 is 16 USD a share.
    const apple = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    expect(apple.draft).toMatchObject({ quantity: 2.025, referencePrice: 216 });
    expect(apple.risk).toEqual({ budget: 30, entryPrice: 216, currentPrice: 216, perShare: expect.closeTo(16 / 1.08, 8) });
    expect(apple.note).toMatch(/^Risk 1% of the account value \(30\.00 EUR\) with a stop-loss at 200 USD: 16 USD a share from 216 down to the stop, converted at 1\.08 USD\/EUR/);
    expect(apple.note).toMatch(/set it once the buy fills/);
    // A limit order is sized from its limit; pence work like any other currency (84.75 GBX per EUR).
    const vusa = await service.resolveOrderIntent({ environment: "demo", instrument: "VUSAl_EQ", side: "buy", type: "limit", limitPrice: 8400, sizing: { mode: "risk", amount: 40, stopLossPrice: 8000 } });
    expect(vusa.draft.quantity).toBe(8.475);
    expect(vusa.risk?.entryPrice).toBe(8400);
    // A reference price is for Market orders; a limit buys at its limit, so a lower reference does not inflate the size.
    const referenced = await service.resolveOrderIntent({ environment: "demo", instrument: "VUSAl_EQ", side: "buy", type: "limit", limitPrice: 8400, referencePrice: 8200, sizing: { mode: "risk", amount: 40, stopLossPrice: 8000 } });
    expect(referenced.draft.quantity).toBe(8.475);
    expect(referenced.risk?.entryPrice).toBe(8400);
    // A Market buy fills near the last price, so a lower reference does not inflate the size either.
    const low = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", referencePrice: 210, sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    expect(low.draft.quantity).toBe(2.025);
    expect(low.risk?.entryPrice).toBe(216);
    expect(low.draft.referencePrice).toBe(216);
    // A Stop the price has already passed triggers at once, so it is sized from the last price too...
    const passed = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "stop", stopPrice: 210, sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    expect(passed.risk?.entryPrice).toBe(216);
    // ...and one above it from its trigger.
    const above = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "stop", stopPrice: 220, sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    expect(above.risk?.entryPrice).toBe(220);
    // 300 EUR at 6 USD a share would be 54 shares, but 1000 EUR of cash buys 5.
    const capped = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", sizing: { mode: "risk", amount: 300, stopLossPrice: 210 } });
    expect(capped.draft.quantity).toBe(5);
    expect(capped.risk?.cashCapped).toBe(true);
    expect(capped.note).toMatch(/all the available cash \(1000\.00 EUR\) buys, so at the stop it would lose about 27\.78 EUR/);
  });

  it("sizes a risk buy of an instrument you do not hold from the quote when that is higher", async () => {
    const quotes: QuoteProvider = { name: "stooq", symbolFor: () => "msft.us", fxRate: async () => undefined,
      quote: async () => ({ ticker: "MSFT_US_EQ", symbol: "msft.us", price: 216, asOf: "2026-10-12T00:00:00.000Z", source: "stooq" as const }) };
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch({ unheld: true }), quotes });
    const risk = { mode: "risk", percent: 1, stopLossPrice: 200 } as const;
    // A reference of 210 would size for a 10 USD fall; the quote says it fills near 216.
    const market = await service.resolveOrderIntent({ environment: "demo", instrument: "MSFT", side: "buy", type: "market", referencePrice: 210, sizing: risk });
    expect(market.risk).toMatchObject({ entryPrice: 216, currentPrice: 216 });
    expect(market.draft.quantity).toBe(2.025);
    // The draft carries the quote, so the review values the order at it rather than at 210.
    expect(market.draft).toMatchObject({ referencePrice: 216, referencePriceAt: "2026-10-12T00:00:00.000Z" });
    // A Stop at 210 has been passed, so it fills near the quote too.
    const stop = await service.resolveOrderIntent({ environment: "demo", instrument: "MSFT", side: "buy", type: "stop", stopPrice: 210, sizing: risk });
    expect(stop.risk?.entryPrice).toBe(216);
    expect(stop.draft.referencePrice).toBe(216);
    // When the quote rises after sizing, the review checks the order at the new quote.
    quotes.quote = async () => ({ ticker: "MSFT_US_EQ", symbol: "msft.us", price: 230, asOf: new Date().toISOString(), source: "stooq" as const });
    const later = await service.prepareOrder({ ...market.draft });
    expect(later.draft.referencePrice).toBe(230);
    expect(later.notices.find((notice) => notice.code === "RISK_OVER_BUDGET")?.details).toMatchObject({ loss: 56.25, budget: 30 });
    quotes.quote = async () => ({ ticker: "MSFT_US_EQ", symbol: "msft.us", price: 216, asOf: "2026-10-12T00:00:00.000Z", source: "stooq" as const });
    // A Limit is sized at its limit but keeps the quote as its reference, for when its type is changed to Market.
    const limit = await service.resolveOrderIntent({ environment: "demo", instrument: "MSFT", side: "buy", type: "limit", limitPrice: 212, sizing: risk });
    expect(limit.risk).toMatchObject({ entryPrice: 212, currentPrice: 216 });
    expect(limit.draft).toMatchObject({ limitPrice: 212, referencePrice: 216, referencePriceAt: "2026-10-12T00:00:00.000Z" });
  });

  it("sends a risk-sized buy only at a loss its review showed, and sees a fall under the stop-loss", async () => {
    const writes: string[] = [];
    let price = 216;
    const quotes: QuoteProvider = { name: "stooq", symbolFor: () => "msft.us", fxRate: async () => undefined,
      quote: async () => ({ ticker: "MSFT_US_EQ", symbol: "msft.us", price, asOf: new Date().toISOString(), source: "stooq" as const }) };
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch({ unheld: true, writes }), quotes });
    const sized = await service.resolveOrderIntent({ environment: "demo", instrument: "MSFT", side: "buy", type: "market", sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    // Reviewed at 216, the quote is 230 by the send: the stop would lose 56.25 EUR, not the 30 the review showed.
    const preview = await service.prepareOrder({ ...sized.draft });
    expect(preview.notices.map((notice) => notice.code)).not.toContain("RISK_OVER_BUDGET");
    price = 230;
    const refused = await service.executeOrder(preview.token);
    expect(refused).toMatchObject({ ok: false, status: "rejected", error: { code: "RISK_CHANGED", details: { loss: 56.25, budget: 30 } } });
    expect(writes).toEqual([]);
    // Reviewed at 230, the review names that loss, and the order is sent at it.
    const again = await service.prepareOrder({ ...sized.draft });
    expect(again.notices.map((notice) => notice.code)).toContain("RISK_OVER_BUDGET");
    expect((await service.executeOrder(again.token)).ok).toBe(true);
    expect(writes).toEqual(["POST /equity/orders/market"]);
    // A fall to 190 keeps the higher price to value the order, but the review says it is under the stop-loss.
    price = 190;
    const fallen = await service.prepareOrder({ ...sized.draft });
    expect(fallen.draft.referencePrice).toBe(216);
    expect(fallen.notices.find((notice) => notice.code === "RISK_STOP_ABOVE_PRICE")?.details).toMatchObject({ price: 190, stopLossPrice: 200 });
    // A Limit at 212 sees the fall too.
    const limit = await service.prepareOrder({ ...sized.draft, type: "limit", limitPrice: 212, timeValidity: "DAY" });
    expect(limit.notices.map((notice) => notice.code)).toContain("RISK_STOP_ABOVE_PRICE");
  });

  it("counts a reference above a Stop's trigger, and carries the budget for the review to check", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    // Trigger 220, last price 216, but the price given is 230: 30 USD a share to the stop, not 20.
    const stop = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "stop", stopPrice: 220, referencePrice: 230, sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    expect(stop.risk?.entryPrice).toBe(230);
    expect(stop.draft).toMatchObject({ referencePrice: 230, riskBudget: { stopLossPrice: 200, budget: 30 } });
    // A Stop fills at the market once triggered, so its review warns that a gap fills above the trigger.
    const stopReview = await service.prepareOrder({ ...stop.draft, referencePriceAt: new Date().toISOString() });
    expect(stopReview.notices.find((notice) => notice.code === "STOP_SLIPPAGE")).toMatchObject({ details: { side: "buy", riskSized: true }, message: expect.stringMatching(/fill above its trigger price; the loss at the stop-loss is counted from the trigger/) });
    const market = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } });
    const fresh = { referencePriceAt: new Date().toISOString() };
    // As sized, the review finds the loss within the budget.
    const asSized = await service.prepareOrder({ ...market.draft, ...fresh });
    expect(asSized.notices.map((notice) => notice.code)).not.toContain("RISK_OVER_BUDGET");
    // After the price moves to 230, or the quantity is raised, it says the loss at the stop is now over the budget.
    const moved = await service.prepareOrder({ ...market.draft, ...fresh, referencePrice: 230 });
    expect(moved.notices.find((notice) => notice.code === "RISK_OVER_BUDGET")?.details).toMatchObject({ loss: 56.25, budget: 30, stopLossPrice: 200 });
    const raised = await service.prepareOrder({ ...market.draft, ...fresh, quantity: 3 });
    expect(raised.notices.find((notice) => notice.code === "RISK_OVER_BUDGET")?.message).toMatch(/would now lose about 44\.44 EUR, more than the 30\.00 EUR it was sized for/);
  });

  it("says when the price is already under the stop-loss a buy was sized for", () => {
    const draft: OrderDraft = { environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 2, riskBudget: { stopLossPrice: 200, budget: 30 } };
    expect(riskNotices(draft, { estimatedNotional: 390, accountNotional: 361.11, estimatedNotionalCurrency: "USD", accountCurrency: "EUR" }).map((notice) => notice.code)).toEqual(["RISK_STOP_ABOVE_PRICE"]);
    expect(riskNotices({ ...draft, side: "sell" }, { estimatedNotional: 390, accountNotional: 361.11, estimatedNotionalCurrency: "USD" })).toEqual([]);
  });

  it("refuses risk sizing that cannot work", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    const intent = (sizing: Record<string, unknown>, side: "buy" | "sell" = "buy") =>
      service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side, type: "market", sizing: { mode: "risk", stopLossPrice: 200, ...sizing } as never });
    await expect(intent({ percent: 1 }, "sell")).rejects.toThrow(/only valid for buy orders/);
    await expect(intent({ percent: 1, amount: 30 })).rejects.toThrow(/either amount .* or percent/);
    await expect(intent({})).rejects.toThrow(/either amount .* or percent/);
    await expect(intent({ percent: 1, stopLossPrice: 220 })).rejects.toThrow(/must be below the entry price \(216 USD\)/);
    // A budget under a cent cannot be carried to the review.
    await expect(intent({ amount: 0.004 })).rejects.toThrow(/at least 0\.01 EUR/);
    // Without the available cash there is nothing to cap the buy at, so it is refused rather than left unlimited.
    const base = fxFetch();
    const noCash = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/equity/account/summary")) return new Response(JSON.stringify({ currency: "EUR", totalValue: 3000 }), { status: 200, headers: { "content-type": "application/json" } });
      return base(input, init);
    }) as typeof fetch;
    const blind = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: noCash });
    await expect(blind.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", sizing: { mode: "risk", percent: 1, stopLossPrice: 200 } })).rejects.toThrow(/available cash is unknown/);
  });

  it("carries a rate given for the account currency on the draft", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    const resolved = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", referencePrice: 216, sizing: { mode: "notional", amount: 108, currency: "EUR", fxRateToInstrumentCurrency: 1.1 } });
    expect(resolved.draft).toMatchObject({ fxRate: 1.1 });
  });

  it("sizes with a rate passed with the intent only where the holdings imply none", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch() });
    // AAPL is held, so its implied 1.08 USD per EUR wins over the passed 2.
    const held = await service.resolveOrderIntent({ environment: "demo", instrument: "AAPL", side: "buy", type: "market", referencePrice: 216, fxRate: 2, sizing: { mode: "cash_percent", percent: 10 } });
    expect(held.draft).toMatchObject({ quantity: 0.5 });
    expect(held.draft.fxRate).toBeUndefined();
    expect(held.note).toMatch(/implied by your holdings/);
  });

  it("reports an accepted write whose response can't be read as unknown, and counts it toward the budget", async () => {
    const store = new MemoryStateStore();
    const broken = () => new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } });
    const service = new TradingService({ config: { ...config(), policy: createConfig({ POLICY_APPLY_TO: "demo", POLICY_DAILY_ORDER_LIMIT: "1", POLICY_MAX_POSITION_WEIGHT: "0" }).policy }, store, fetcher: fxFetch({ writeBody: broken }) });
    const preview = await service.prepareOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 216, referencePriceAt: new Date().toISOString() });
    const result = await service.executeOrder(preview.token);
    expect(result.status).toBe("unknown");
    expect(result.verificationId).toBeTruthy();
    await expect(service.prepareOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 216, referencePriceAt: new Date().toISOString() })).rejects.toThrow(/order 2 today; the daily limit is 1/);
  });

  it("needs the second confirmation to cancel a Live order and keeps the token until then", async () => {
    const writes: string[] = [];
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fxFetch({ writes }) });
    const preview = await service.prepareCancel("live", "42");
    expect(preview.order).toMatchObject({ ticker: "AAPL_US_EQ", type: "STOP" });
    await expect(service.executeCancel(preview.token)).rejects.toThrow(/second confirmation/);
    expect(writes).toEqual([]);
    expect((await service.executeCancel(preview.token, { liveAcknowledged: true })).status).toBe("submitted");
    expect(writes).toEqual(["DELETE /equity/orders/42"]);
  });
});
