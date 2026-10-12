import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { createQuoteProvider, parseSymbolMap, usSymbol } from "./quotes.js";
import { MemoryStateStore } from "./state-store.js";

const aapl: Instrument = { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", type: "STOCK" };
const vusa: Instrument = { ticker: "VUSAl_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "GBP", type: "ETF" };

/** Fake quote endpoints plus a USD Trading 212 account that holds nothing. */
function fakeFetch(calls: string[] = []) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.startsWith("https://stooq.com/")) {
      const rows: Record<string, string> = { "aapl.us": "AAPL.US,2026-10-09,22:00:09,250.5", "vusl.uk": "VUSL.UK,2026-10-09,16:35:00,80", usdgbp: "USDGBP,2026-10-09,21:59:58,0.79" };
      return new Response(`Symbol,Date,Time,Close\r\n${rows[new URL(url).searchParams.get("s") ?? ""] ?? "X,N/D,N/D,N/D"}\r\n`);
    }
    if (url.startsWith("https://finnhub.io/")) return json({ c: 251.25, t: 1_791_000_000 });
    if (init?.method === "POST") return json({ id: 1, ...(JSON.parse(String(init.body)) as object) });
    if (url.endsWith("/equity/metadata/instruments")) return json([aapl, vusa]);
    if (url.endsWith("/equity/positions")) return json([] satisfies Position[]);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "USD", totalValue: 5000, cash: { availableToTrade: 5000 } });
    return json([]);
  }) as typeof fetch;
}

function services(env: RuntimeEnv = {}, calls: string[] = []) {
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", ...env });
  return createServices({ config, store: new MemoryStateStore(), fetcher: fakeFetch(calls) });
}

describe("quote symbols", () => {
  it("maps US tickers and explicit overrides only", () => {
    expect(usSymbol("AAPL_US_EQ")).toBe("AAPL");
    expect(usSymbol("BRK.B_US_EQ")).toBe("BRK.B");
    expect(usSymbol("VUSAl_EQ")).toBeUndefined();
    expect(parseSymbolMap("VUSAl_EQ=VUSA.UK, SAPd_EQ=SAP.DE")).toEqual(new Map([["VUSAL_EQ", "VUSA.UK"], ["SAPD_EQ", "SAP.DE"]]));
    expect(() => parseSymbolMap("VUSA")).toThrow(/TICKER=SYMBOL/);
  });
});

describe("quote providers", () => {
  it("reads Stooq by default without a key and caches the result", async () => {
    const calls: string[] = [];
    const provider = createQuoteProvider(createConfig({}), fakeFetch(calls))!;
    expect(provider.name).toBe("stooq");
    expect(await provider.quote(aapl)).toMatchObject({ symbol: "AAPL.US", price: 250.5, asOf: "2026-10-09T22:00:09Z", source: "stooq" });
    await provider.quote(aapl);
    expect(calls).toHaveLength(1);
    expect(await provider.quote(vusa)).toBeUndefined();
  });

  it("uses an explicit symbol map and reports no data as no price", async () => {
    const provider = createQuoteProvider(createConfig({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSA.UK" }), fakeFetch())!;
    expect(provider.symbolFor(vusa)).toBe("VUSA.UK");
    expect(() => createConfig({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSA.L*abc" })).toThrow(/factor/);
    expect(await provider.quote(vusa)).toBeUndefined();
  });

  it("needs a key for the keyed providers and can be turned off", async () => {
    expect(createQuoteProvider(createConfig({ QUOTE_PROVIDER: "finnhub" }), fakeFetch())).toBeUndefined();
    expect(createQuoteProvider(createConfig({ QUOTE_PROVIDER: "none" }), fakeFetch())).toBeUndefined();
    expect(() => createConfig({ QUOTE_PROVIDER: "bloomberg" })).toThrow(/QUOTE_PROVIDER/);
    const finnhub = createQuoteProvider(createConfig({ QUOTE_PROVIDER: "finnhub", QUOTE_API_KEY: "key" }), fakeFetch())!;
    expect(await finnhub.quote(aapl)).toMatchObject({ symbol: "AAPL", price: 251.25, source: "finnhub" });
  });
});

describe("fresh quotes", () => {
  it("reads past the cache when asked to, and keeps the cache when that read fails", async () => {
    let close: string | undefined = "250.5";
    const calls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (close === undefined) throw new Error("offline");
      return new Response(`Symbol,Date,Time,Close\r\n${(new URL(url).searchParams.get("s") ?? "").toUpperCase()},2026-10-09,22:00:09,${close}\r\n`);
    }) as typeof fetch;
    const provider = createQuoteProvider(createConfig({}), fetcher)!;
    expect((await provider.quote(aapl))?.price).toBe(250.5);
    close = "260";
    expect((await provider.quote(aapl))?.price).toBe(250.5);
    expect((await provider.quote(aapl, { fresh: true }))?.price).toBe(260);
    // The fresh read refreshed the cache for everyone else.
    expect((await provider.quote(aapl))?.price).toBe(260);
    close = undefined;
    expect(await provider.quote(aapl, { fresh: true })).toBeUndefined();
    expect((await provider.quote(aapl))?.price).toBe(260);
    expect(calls).toHaveLength(3);

    close = "0.79";
    expect((await provider.fxRate("USD", "GBP"))?.rate).toBe(0.79);
    close = "0.8";
    expect((await provider.fxRate("USD", "GBP"))?.rate).toBe(0.79);
    expect((await provider.fxRate("USD", "GBX", { fresh: true }))?.rate).toBeCloseTo(80, 9);
    expect((await provider.fxRate("USD", "GBP"))?.rate).toBe(0.8);
    close = undefined;
    expect(await provider.fxRate("USD", "GBP", { fresh: true })).toBeUndefined();
    expect((await provider.fxRate("USD", "GBP"))?.rate).toBe(0.8);
  });
});

describe("exchange rates from the quote provider", () => {
  it("reads a pair, treats pence as pounds and caches it", async () => {
    const calls: string[] = [];
    const provider = createQuoteProvider(createConfig({}), fakeFetch(calls))!;
    expect(await provider.fxRate("USD", "GBP")).toEqual({ from: "USD", to: "GBP", rate: 0.79, asOf: "2026-10-09T21:59:58Z", source: "stooq" });
    expect((await provider.fxRate("usd", "GBX"))?.rate).toBeCloseTo(79, 9);
    expect(calls.filter((url) => url.includes("s=usdgbp"))).toHaveLength(1);
    expect(await provider.fxRate("USD", "CHF")).toBeUndefined();
    expect(await provider.fxRate("USD", "USD")).toBeUndefined();
    expect(await provider.fxRate("USD", "../x")).toBeUndefined();
    // Finnhub's exchange rates are not on its free plan.
    expect(await createQuoteProvider(createConfig({ QUOTE_PROVIDER: "finnhub", QUOTE_API_KEY: "key" }), fakeFetch())!.fxRate("USD", "GBP")).toBeUndefined();
  });

  it("values an order in a currency no holding is priced in, so the notional cap can be checked", async () => {
    const { trading } = services({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK" });
    const resolved = await trading.resolveOrderIntent({ environment: "demo", instrument: "VUSAl_EQ", side: "buy", type: "market", sizing: { mode: "notional", amount: 100, currency: "USD" } });
    // 100 USD is 79 GBP at the provider's rate; at 80 GBP a share that is 0.9875 shares.
    expect(resolved.draft).toMatchObject({ quantity: 0.9875, referencePrice: 80, fxRate: 0.79, fxRateAt: "2026-10-09T21:59:58Z" });
    expect(resolved.note).toMatch(/stooq rate as of 2026-10-09T21:59:58Z/);
    const preview = await trading.prepareOrder(resolved.draft);
    expect(preview.estimatedAccountNotional).toBeCloseTo(100, 6);
  });

  it("sizes a plan leg and a rebalance target in a currency no holding is priced in", async () => {
    const { automation, trading } = services({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK" });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSAl_EQ", amount: 100 }], frequency: "monthly", dayOfMonth: 1 });
    expect((await automation.reviewPlan(plan.id)).legs[0]?.draft).toMatchObject({ ticker: "VUSAl_EQ", quantity: 0.9875, fxRate: 0.79 });
    const rebalance = await trading.planRebalance("demo", [{ ticker: "VUSAl_EQ", weight: 0.1 }]);
    expect(rebalance.skipped).toEqual([]);
    expect(rebalance.trades[0]).toMatchObject({ ticker: "VUSAl_EQ", side: "buy", currency: "GBP" });
    expect(rebalance.noteDetails?.find((note) => note.code === "quoted_rates")?.details).toMatchObject({ currencies: "GBP", source: "stooq" });
  });
});

describe("quotes for instruments you do not hold", () => {
  it("scales a mapped quote into the instrument's unit", async () => {
    const { trading } = services({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK*100" });
    expect(await trading.lookupPrice("demo", "VUSAl_EQ")).toMatchObject({ price: 8000, symbol: "VUSL.UK" });
  });

  it("answers get_quote-style lookups from the provider", async () => {
    const { trading } = services();
    expect(await trading.lookupPrice("demo", "AAPL")).toMatchObject({ price: 250.5, source: "stooq" });
    expect((await trading.lookupPrice("demo", "VUSAl_EQ")).message).toMatch(/QUOTE_SYMBOLS/);
  });

  it("sizes a plan leg that is not held yet", async () => {
    const { automation } = services();
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "AAPL", amount: 501 }], frequency: "monthly", dayOfMonth: 1 });
    const review = await automation.reviewPlan(plan.id);
    expect(review.legs[0]?.draft).toMatchObject({ ticker: "AAPL_US_EQ", quantity: 2, referencePrice: 250.5 });
  });

  it("fills the reference price of a rebalance target", async () => {
    const { trading } = services();
    const plan = await trading.planRebalance("demo", [{ ticker: "AAPL", weight: 0.1 }]);
    expect(plan.trades[0]).toMatchObject({ ticker: "AAPL_US_EQ", side: "buy", price: 250.5 });
  });

  it("checks a price alert on an instrument that is not held", async () => {
    const { alerts, runScheduled } = services();
    await alerts.create({ environment: "demo", instrument: "AAPL", condition: "above", price: 250 });
    expect((await runScheduled()).alerts[0]).toMatchObject({ action: "triggered" });
  });
});
