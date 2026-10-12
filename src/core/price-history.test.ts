import { describe, expect, it } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { createPriceHistory, samplePriceHistory } from "./price-history.js";
import { createQuoteProvider } from "./quotes.js";

const aapl: Instrument = { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", type: "STOCK" };
const vusa: Instrument = { ticker: "VUSAl_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "GBX", type: "ETF" };
const from = new Date("2026-10-01T00:00:00Z");

/** Daily history endpoints of each provider, answering for the symbols they know; every URL asked is kept. */
function historyFetch(calls: string[] = [], fail = { now: false }) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: URL | RequestInfo) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(url.toString());
    if (fail.now) throw new Error("offline");
    if (url.host === "stooq.com") {
      if (url.searchParams.get("s") !== "aapl.us" && url.searchParams.get("s") !== "vusl.uk") return new Response("No data");
      // Out of order, a day before the start, and one day twice.
      return new Response("Date,Open,High,Low,Close,Volume\r\n2026-10-02,1,1,1,101.5,10\r\n2026-09-30,1,1,1,99,10\r\n2026-10-01,1,1,1,100,10\r\n2026-10-05,1,1,1,n/a,10\r\n2026-10-02,1,1,1,101.5,10\r\n");
    }
    if (url.host === "api.twelvedata.com") return json({ status: "ok", values: [{ datetime: "2026-10-02", close: "201.25" }, { datetime: "2026-10-01", close: "200" }] });
    if (url.host === "www.alphavantage.co") return json({ "Time Series (Daily)": { "2026-10-02": { "4. close": "301.5" }, "2026-10-01": { "4. close": "300" }, "2026-09-15": { "4. close": "290" } } });
    return json({});
  }) as typeof fetch;
}

const provider = (env: RuntimeEnv, calls: string[] = [], fail = { now: false }) => createQuoteProvider(createConfig(env), historyFetch(calls, fail))!;

describe("daily prices from the quote provider", () => {
  it("reads Stooq's CSV from the start asked for, one close a day, oldest first, and caches it", async () => {
    const calls: string[] = [];
    const stooq = provider({}, calls);
    expect(await stooq.history!(aapl, from)).toEqual({ source: "stooq", symbol: "AAPL.US", points: [{ date: "2026-10-01", close: 100 }, { date: "2026-10-02", close: 101.5 }] });
    expect(calls[0]).toMatch(/^https:\/\/stooq\.com\/q\/d\/l\/\?s=aapl\.us&d1=20261001&d2=\d{8}&i=d$/);
    await stooq.history!(aapl, from);
    expect(calls).toHaveLength(1);
    // "No data" is no history; so is an instrument with no symbol, which asks nothing.
    expect(await stooq.history!({ ...aapl, ticker: "ZZZZ_US_EQ" }, from)).toBeUndefined();
    expect(await stooq.history!(vusa, from)).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("scales a mapped symbol into the instrument's unit", async () => {
    const stooq = provider({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK*100" });
    expect((await stooq.history!(vusa, from))?.points).toEqual([{ date: "2026-10-01", close: 10_000 }, { date: "2026-10-02", close: 10_150 }]);
  });

  it("reads Twelve Data and Alpha Vantage, and has none from Finnhub's free plan", async () => {
    const twelve = provider({ QUOTE_PROVIDER: "twelvedata", QUOTE_API_KEY: "k" });
    expect(await twelve.history!(aapl, from)).toEqual({ source: "twelvedata", symbol: "AAPL", points: [{ date: "2026-10-01", close: 200 }, { date: "2026-10-02", close: 201.25 }] });
    const alpha = provider({ QUOTE_PROVIDER: "alphavantage", QUOTE_API_KEY: "k" });
    expect((await alpha.history!(aapl, from))?.points).toEqual([{ date: "2026-10-01", close: 300 }, { date: "2026-10-02", close: 301.5 }]);
    expect(provider({ QUOTE_PROVIDER: "finnhub", QUOTE_API_KEY: "k" }).history).toBeUndefined();
  });

  it("asks again soon after a failed read", async () => {
    const calls: string[] = [];
    const fail = { now: true };
    const stooq = provider({}, calls, fail);
    expect(await stooq.history!(aapl, from)).toBeUndefined();
    fail.now = false;
    // The miss is kept for a minute, not half an hour.
    expect(await stooq.history!(aapl, from)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("the price chart's closes", () => {
  const history = (env: RuntimeEnv) => {
    const quotes = createQuoteProvider(createConfig(env), historyFetch());
    return createPriceHistory({ sampleData: false, ...(quotes ? { quotes } : {}) });
  };

  it("says why there are none, case by case", async () => {
    expect(await history({ QUOTE_PROVIDER: "none" })({ instrument: aapl, from })).toMatchObject({ missing: "provider" });
    expect(await history({ QUOTE_PROVIDER: "finnhub", QUOTE_API_KEY: "k" })({ instrument: aapl, from })).toMatchObject({ missing: "plan" });
    expect(await history({})({ instrument: vusa, from })).toMatchObject({ missing: "symbol", problem: expect.stringContaining("QUOTE_SYMBOLS") });
    expect(await history({})({ instrument: { ...aapl, ticker: "ZZZZ_US_EQ" }, from })).toMatchObject({ missing: "data" });
  });

  it("refuses closes in another unit than Trading 212's price, checked against the last price or the newest fill", async () => {
    // Pounds from the provider for a fund Trading 212 prices in pence.
    const pounds = history({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK" });
    expect(await pounds({ instrument: vusa, from, last: 9175 })).toMatchObject({ missing: "unit", problem: expect.stringContaining("VUSAl_EQ=VUSL.UK*100") });
    const fills = Promise.resolve([{ at: "2026-09-01T10:00:00Z", price: 50 }, { at: "2026-09-20T10:00:00Z", price: 9100 }]);
    expect(await pounds({ instrument: vusa, from, fills })).toMatchObject({ missing: "unit" });
    expect(await history({ QUOTE_SYMBOLS: "VUSAl_EQ=VUSL.UK*100" })({ instrument: vusa, from, last: 9175, fills })).toMatchObject({ prices: { points: [{ close: 10_000 }, { close: 10_150 }] } });
    // Far moves of the broker's own kind are fine: three times is a real move, not a unit.
    expect(await history({})({ instrument: aapl, from, last: 300 })).toHaveProperty("prices");
  });

  it("draws the sample account a path through its fills, ending at the last price, for holdings only", async () => {
    const now = () => new Date("2026-10-12T12:00:00Z");
    const sample = createPriceHistory({ sampleData: true, now });
    expect(await sample({ instrument: aapl, from: new Date("2025-10-12T00:00:00Z") })).toMatchObject({ missing: "sample" });
    const result = await sample({ instrument: aapl, from: new Date("2025-10-12T00:00:00Z"), last: 231.55, fills: Promise.resolve([{ at: "2026-05-24T14:00:00Z", price: 190 }, { at: "2026-09-22T14:00:00Z", price: 220.5 }]) });
    if (!("prices" in result)) throw new Error("no prices");
    const { points } = result.prices;
    expect(result.prices.source).toBe("sample");
    expect(points.every((point) => ![0, 6].includes(new Date(`${point.date}T00:00:00Z`).getUTCDay()))).toBe(true);
    expect(points.at(-1)).toEqual({ date: "2026-10-12", close: 231.55 });
    expect(points.find((point) => point.date === "2026-09-22")?.close).toBe(220.5);
    // A fill on a Sunday sits on the Friday before.
    expect(points.find((point) => point.date === "2026-05-22")?.close).toBe(190);
    expect(points[0]!.date).toBe("2025-10-13");
    // The same ticker draws the same path.
    expect(samplePriceHistory("AAPL_US_EQ", { from: new Date("2025-10-12T00:00:00Z"), to: now(), last: 231.55, anchors: [] }))
      .toEqual(samplePriceHistory("AAPL_US_EQ", { from: new Date("2025-10-12T00:00:00Z"), to: now(), last: 231.55, anchors: [] }));
  });
});
