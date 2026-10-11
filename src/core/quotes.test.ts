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
      const symbol = new URL(url).searchParams.get("s");
      return new Response(symbol === "aapl.us" ? "Symbol,Date,Time,Close\r\nAAPL.US,2026-10-09,22:00:09,250.5\r\n" : "Symbol,Date,Time,Close\r\nX,N/D,N/D,N/D\r\n");
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

describe("quotes for instruments you do not hold", () => {
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
