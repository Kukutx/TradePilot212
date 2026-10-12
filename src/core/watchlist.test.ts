import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import type { PricePoint } from "../shared/prices.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";
import { Watchlist, watchFigures, watchLevels, watchlistView } from "./watchlist.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
}

/** A copy of the trading service whose quote provider answers `quote` (undefined: no answer). */
function withQuote(services: ReturnType<typeof sample>, quote: (ticker: string) => number | undefined, asOf = "2026-10-12T15:00:00Z") {
  const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, {
    externalQuote: async (instrument: { ticker: string }) => {
      const price = quote(instrument.ticker);
      return price === undefined ? undefined : { ticker: instrument.ticker, symbol: instrument.ticker, price, asOf, source: "stooq" };
    },
  });
  return trading as typeof services.trading;
}

/** Weekday closes from `start` for `days` calendar days, from `first` rising by `step` a day. */
function closes(start: string, days: number, first = 100, step = 1): PricePoint[] {
  const points: PricePoint[] = [];
  for (let day = 0; day < days; day++) {
    const date = new Date(Date.parse(`${start}T00:00:00Z`) + day * 86_400_000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) points.push({ date: date.toISOString().slice(0, 10), close: first + day * step });
  }
  return points;
}

describe("watchlist store", () => {
  it("adds instruments by name or symbol at the price they are at, changes a note, and removes them", async () => {
    const { watchlist } = sample();
    const tesla = await watchlist.add("demo", "Tesla", "  Wait for delivery numbers  ", new Date("2026-10-01T10:00:00Z"));
    expect(tesla).toMatchObject({ added: true, item: { ticker: "TSLA_US_EQ", note: "Wait for delivery numbers", addedPrice: 244.1 } });
    // A holding is added at Trading 212's price.
    expect((await watchlist.add("demo", "NVDA", undefined, new Date("2026-10-02T10:00:00Z"))).item.addedPrice).toBe(128.75);
    // Again: the note changes, nothing else; no note leaves it as it is; an empty one clears it.
    expect(await watchlist.add("demo", "TSLA", "Earnings first")).toMatchObject({ added: false, item: { note: "Earnings first", addedAt: tesla.item.addedAt } });
    expect((await watchlist.add("demo", "TSLA_US_EQ")).item.note).toBe("Earnings first");
    expect((await watchlist.add("demo", "TSLA", "")).item.note).toBeUndefined();
    expect((await watchlist.list("demo")).map((item) => item.ticker)).toEqual(["TSLA_US_EQ", "NVDA_US_EQ"]);
    expect(await watchlist.list("live")).toEqual([]);
    // A note change never adds one that is not on the list.
    await expect(watchlist.note("demo", "AMZN", "Cloud margins")).rejects.toThrow("AMZN is not on the watchlist");
    expect((await watchlist.note("demo", "TSLA", "After the call")).note).toBe("After the call");
    expect((await watchlist.remove("demo", "tsla_us_eq")).ticker).toBe("TSLA_US_EQ");
    await expect(watchlist.remove("demo", "Tesla")).rejects.toThrow("Tesla is not on the watchlist");
    expect((await watchlist.list("demo")).map((item) => item.ticker)).toEqual(["NVDA_US_EQ"]);
  });

  it("refuses an instrument Trading 212 does not list, and a 51st", async () => {
    const services = sample();
    await expect(services.watchlist.add("demo", "NOPE_XX_EQ")).rejects.toThrow();
    const store = new MemoryStateStore();
    for (let index = 0; index < 50; index++) await store.put(`watch:demo:T${index}`, { environment: "demo", ticker: `T${index}`, addedAt: "2026-01-01T00:00:00Z" });
    const full = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store, fetcher: (async () => new Response("{}")) as typeof fetch });
    await expect(full.watchlist.add("demo", "TSLA")).rejects.toThrow("at most 50");
  });

  it("keeps the cap when adds come at once", async () => {
    const store = new MemoryStateStore();
    for (let index = 0; index < 49; index++) await store.put(`watch:demo:T${index}`, { environment: "demo", ticker: `T${index}`, addedAt: "2026-01-01T00:00:00Z" });
    const { watchlist } = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store, fetcher: (async () => new Response("{}")) as typeof fetch });
    const results = await Promise.allSettled(["TSLA", "AMZN", "ASML"].map((instrument) => watchlist.add("demo", instrument)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await watchlist.list("demo")).toHaveLength(50);
  });

  it("changes the note of, and removes, an instrument Trading 212 no longer lists", async () => {
    const store = new MemoryStateStore();
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store, fetcher: (async () => new Response("{}")) as typeof fetch });
    await services.watchlist.add("demo", "TSLA");
    const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, { instruments: async () => [] });
    const watchlist = new Watchlist({ config, store, trading });
    expect((await watchlist.note("demo", "TSLA_US_EQ", "Delisted?")).note).toBe("Delisted?");
    expect((await watchlist.add("demo", "TSLA_US_EQ", "Still delisted")).item.note).toBe("Still delisted");
    expect((await watchlist.remove("demo", "TSLA_US_EQ")).ticker).toBe("TSLA_US_EQ");
  });
});

describe("watchlist figures", () => {
  const year = closes("2025-10-10", 367);

  it("gives each change the closes cover, the range and a sparkline ending at the price now", () => {
    const figures = watchFigures({ price: 470, day: "2026-10-12", points: year });
    const last = year.filter((point) => point.date < "2026-10-12").at(-1)!;
    expect(figures.changes["1d"]).toBeCloseTo(470 / last.close - 1, 6);
    // The year runs back from the newest close, so it starts at the first one.
    expect(figures.changes["1y"]).toBeCloseTo(470 / year[0]!.close - 1, 6);
    expect(Object.keys(figures.changes)).toEqual(["1d", "1m", "3m", "1y"]);
    expect(figures.high).toBe(470);
    expect(figures.low).toBe(year[0]!.close);
    expect(figures.spark!.closes.at(-1)).toBe(470);
    expect(figures.spark!.closes.length).toBeLessThan(70);
    // Three months back from the newest close before today, Friday 9 October.
    expect(figures.spark!.from).toBe("2026-07-09");
  });

  it("leaves out the changes the closes do not cover, and counts a close's own day as the price's", () => {
    const month = closes("2026-09-07", 36);
    const figures = watchFigures({ price: month.at(-1)!.close, day: month.at(-1)!.date, points: month });
    expect(Object.keys(figures.changes)).toEqual(["1d", "1m"]);
    // The day before the last close, not the last close itself.
    expect(figures.changes["1d"]).toBeCloseTo(month.at(-1)!.close / month.at(-2)!.close - 1, 6);
    expect(watchFigures({ price: 10, day: "2026-10-12", points: [] })).toEqual({ changes: {} });
  });

  it("gives the range from the first close when the closes cover less than a year", () => {
    const month = closes("2026-09-07", 36);
    expect(watchFigures({ price: 200, day: "2026-10-12", points: month }).rangeFrom).toBe(month[0]!.date);
    expect(watchFigures({ price: 470, day: "2026-10-12", points: year }).rangeFrom).toBeUndefined();
  });

  it("collects the open orders at their trigger and the armed above and below alerts", () => {
    const levels = watchLevels("TSLA_US_EQ", [
      { id: 1, ticker: "TSLA_US_EQ", quantity: 3, type: "LIMIT", limitPrice: 215 },
      { id: 2, ticker: "TSLA_US_EQ", quantity: -3, type: "STOP_LIMIT", stopPrice: 200, limitPrice: 198 },
      { id: 3, ticker: "AAPL_US_EQ", quantity: 1, type: "LIMIT", limitPrice: 100 },
      { id: 4, ticker: "TSLA_US_EQ", quantity: 1, type: "MARKET" },
    ], [
      { id: "a", environment: "demo", ticker: "TSLA_US_EQ", condition: "above", price: 260, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", environment: "demo", ticker: "TSLA_US_EQ", condition: "below", price: 220, createdAt: "2026-01-01T00:00:00Z", triggeredAt: "2026-02-01T00:00:00Z" },
      { id: "c", environment: "demo", ticker: "TSLA_US_EQ", condition: "trailing_drop", percent: 8, createdAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(levels).toEqual([
      { kind: "limit", side: "buy", price: 215 },
      { kind: "stop", side: "sell", price: 200 },
      { kind: "alert", condition: "above", price: 260 },
    ]);
  });
});

describe("watchlist view", () => {
  it("prices holdings from Trading 212 and the rest from the quote provider, with the levels around them", async () => {
    const services = sample();
    await services.watchlist.add("demo", "NVDA", undefined, new Date(Date.now() - 3000));
    await services.watchlist.add("demo", "TSLA", "Wait for delivery numbers", new Date(Date.now() - 2000));
    await services.watchlist.add("demo", "ASML", undefined, new Date(Date.now() - 1000));
    await services.alerts.create({ environment: "demo", instrument: "TSLA", condition: "above", price: 260 });
    const view = await watchlistView(services, "demo");
    expect(view.items.map((row) => [row.ticker, row.price, row.priceSource])).toEqual([
      ["NVDA_US_EQ", 128.75, "broker"],
      ["TSLA_US_EQ", 244.1, "sample"],
      ["ASMLa_EQ", 642.3, "sample"],
    ]);
    const [nvda, tsla, asml] = view.items;
    expect(nvda).toMatchObject({ held: { quantity: 20, averagePrice: 96.3 }, levels: [{ kind: "stop", side: "sell", price: 118 }] });
    expect(nvda!.levels[0]!.distance).toBeCloseTo(118 / 128.75 - 1, 6);
    expect(tsla!.levels.map((level) => [level.kind, level.price])).toEqual([["alert", 260], ["limit", 215]]);
    expect(Object.keys(tsla!.changes)).toEqual(["1d", "1m", "3m", "1y"]);
    expect(tsla!.spark!.closes.at(-1)).toBe(244.1);
    expect(tsla!.high).toBeGreaterThanOrEqual(244.1);
    expect(asml).toMatchObject({ name: "ASML Holding", currencyCode: "EUR", sinceAdded: 0 });
    const text = describePayload(view);
    expect(text).toMatch(/^Watchlist on DEMO, 3 instrument\(s\)/m);
    expect(text).toMatch(/^NVDA_US_EQ \(NVIDIA\): 128\.75 USD \(Trading 212\); 1D [+-][\d.]+%, 1M [+-][\d.]+%, 3M [+-][\d.]+%, 1Y [+-][\d.]+%; 12-month range [\d.]+ to [\d.]+, [\d.]+% below the high; sell stop 118 \(-8\.3%\); held 20 at 96\.3; \+0% since added \d{4}-\d{2}-\d{2}\.$/m);
    expect(text).toMatch(/^TSLA_US_EQ \(Tesla\): 244\.1 USD \(simulated\); .*alert above 260 \(\+6\.5%\), buy limit 215 \(-11\.9%\); \+0% since added \d{4}-\d{2}-\d{2}; note: "Wait for delivery numbers"\.$/m);
  });

  it("keeps the rows past the read's time for the next read, with what Trading 212 knows", async () => {
    const services = sample();
    await services.watchlist.add("demo", "NVDA", undefined, new Date(Date.now() - 2000));
    await services.watchlist.add("demo", "TSLA", undefined, new Date(Date.now() - 1000));
    const view = await watchlistView({ ...services, budgetMs: -1 }, "demo");
    expect(view.items[0]).toMatchObject({ ticker: "NVDA_US_EQ", price: 128.75, priceSource: "broker", pricesMissing: "later", changes: {} });
    expect(view.items[1]).toMatchObject({ ticker: "TSLA_US_EQ", pricesMissing: "later" });
    expect(view.items[1]!.price).toBeUndefined();
    expect(describePayload(view)).toMatch(/^TSLA_US_EQ \(Tesla\): no price; buy limit 215; no daily closes: Asked on the next read/m);
  });

  it("falls back to the last close without a quote, and drops a quote in another unit", async () => {
    const services = sample();
    await services.watchlist.add("demo", "TSLA");
    await services.watchlist.add("demo", "AMZN");
    const points = closes("2026-07-01", 90);
    const view = await watchlistView({
      ...services,
      trading: withQuote(services, (ticker) => (ticker === "AMZN_US_EQ" ? 1864 : undefined)),
      priceHistory: async ({ instrument }) => (instrument.ticker === "TSLA_US_EQ"
        ? { prices: { source: "stooq", symbol: "TSLA.US", points } }
        : { missing: "unit", problem: "Stooq's closes for AMZN.US look like another unit." }),
    }, "demo");
    const tsla = view.items.find((row) => row.ticker === "TSLA_US_EQ");
    const amzn = view.items.find((row) => row.ticker === "AMZN_US_EQ");
    expect(tsla).toMatchObject({ price: points.at(-1)!.close, priceSource: "close", priceAt: points.at(-1)!.date });
    expect(tsla!.changes["1d"]).toBeCloseTo(points.at(-1)!.close / points.at(-2)!.close - 1, 6);
    expect(amzn).toMatchObject({ pricesMissing: "unit" });
    expect(amzn!.price).toBeUndefined();
    // Added at 186.4 (the sample's quote); a price ten times that is no "since added".
    expect(amzn!.sinceAdded).toBeUndefined();
  });

  it("compares a quote from an earlier day with the close before that day", async () => {
    const services = sample();
    await services.watchlist.add("demo", "AMZN");
    const points = closes("2026-07-01", 101);
    expect(points.at(-1)!.date).toBe("2026-10-09");
    // Friday's price on the Monday morning: 1D is Friday against Thursday, not Friday against itself.
    const friday = points.at(-1)!.close;
    const view = await watchlistView({
      ...services,
      trading: withQuote(services, () => friday, "2026-10-09T20:00:00Z"),
      priceHistory: async () => ({ prices: { source: "stooq", symbol: "AMZN.US", points } }),
    }, "demo", new Date("2026-10-12T07:00:00Z"));
    expect(view.items[0]!.changes["1d"]).toBeCloseTo(friday / points.at(-2)!.close - 1, 6);
    expect(view.items[0]!.rangeFrom).toBe("2026-07-01");
    expect(describePayload(view)).toMatch(/; range since 2026-07-01 [\d.]+ to [\d.]+, 0% below the high;/);
  });

  it("checks a quote against the orders and alerts for its unit when the closes did not come", async () => {
    const services = sample();
    await services.watchlist.add("demo", "TSLA");
    const view = await watchlistView({
      ...services,
      trading: withQuote(services, () => 2.441),
      priceHistory: async () => ({ missing: "data", problem: "Stooq took more than 3 seconds." }),
    }, "demo");
    const tsla = view.items[0]!;
    expect(tsla.price).toBeUndefined();
    expect(tsla.levels[0]!.distance).toBeUndefined();
    expect(tsla).toMatchObject({ pricesMissing: "unit" });
    expect(tsla.pricesProblem).toContain("multiply the factor in its QUOTE_SYMBOLS mapping by 100 (TSLA_US_EQ=TSLA_US_EQ*100 when it has none)");
  });

  it("says when Trading 212 no longer lists an instrument on the list", async () => {
    const services = sample();
    await services.watchlist.add("demo", "TSLA");
    const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, { instruments: async () => [] });
    const view = await watchlistView({ ...services, trading }, "demo");
    expect(view.items[0]).toMatchObject({ ticker: "TSLA_US_EQ", pricesMissing: "data", pricesProblem: "Trading 212 does not list TSLA_US_EQ at the moment." });
  });
});
