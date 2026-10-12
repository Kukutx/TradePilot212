import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { InsightsService, parseWindow } from "./insights-service.js";

const config = {
  trading212: {
    demo: { baseUrl: "https://demo.test/api/v0", apiKey: "key", apiSecret: "secret" },
    live: { baseUrl: "https://live.test/api/v0", apiKey: "", apiSecret: "" },
  },
} as RuntimeConfig;

function fetcherFor(pages: Record<string, unknown>, calls: string[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const body = pages[url];
    return body === undefined ? new Response("missing", { status: 404 }) : Response.json(body);
  };
}

describe("history collection", () => {
  it("follows nextPagePath and stops at the window start", async () => {
    const calls: string[] = [];
    const service = new InsightsService({
      config,
      instruments: async () => [],
      fetcher: fetcherFor({
        "https://demo.test/api/v0/equity/history/dividends?limit=50": { items: [{ paidOn: "2026-09-01T00:00:00Z", amount: 1 }], nextPagePath: "/api/v0/equity/history/dividends?limit=50&cursor=2" },
        "https://demo.test/api/v0/equity/history/dividends?limit=50&cursor=2": { items: [{ paidOn: "2025-01-01T00:00:00Z", amount: 2 }], nextPagePath: "/api/v0/equity/history/dividends?limit=50&cursor=3" },
      }, calls),
    });
    const result = await service.collect("demo", "dividends", { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("marks results truncated when the page budget runs out", async () => {
    const page = (n: number) => ({ items: [{ dateTime: "2026-09-01T00:00:00Z", amount: n }], nextPagePath: `/api/v0/equity/history/transactions?cursor=${n + 1}` });
    const service = new InsightsService({
      config,
      instruments: async () => [],
      fetcher: fetcherFor({
        "https://demo.test/api/v0/equity/history/transactions?limit=50": page(1),
        "https://demo.test/api/v0/equity/history/transactions?cursor=2": page(2),
      }, []),
    });
    const result = await service.collect("demo", "transactions", { to: new Date() }, 2);
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("names a fill's instrument when the order carries its ticker only on the instrument", async () => {
    const service = new InsightsService({
      config,
      instruments: async () => [],
      fetcher: fetcherFor({
        "https://demo.test/api/v0/equity/history/orders?limit=50": {
          items: [{ order: { id: 7, side: "BUY", instrument: { ticker: "AAPL_US_EQ", name: "Apple" } }, fill: { filledAt: "2026-10-09T14:00:00Z", quantity: 2, price: 230 } }],
        },
      }, []),
    });
    const history = await service.tradeHistory("demo", { from: new Date("2026-10-09T00:00:00Z"), to: new Date("2026-10-10T00:00:00Z") });
    expect(history.fills[0]).toMatchObject({ ticker: "AAPL_US_EQ", name: "Apple", price: 230 });
  });

  it("reads the exchanges once for callers at the same moment", async () => {
    const calls: string[] = [];
    const service = new InsightsService({
      config,
      instruments: async () => [],
      fetcher: fetcherFor({ "https://demo.test/api/v0/equity/metadata/exchanges": [{ id: 1, name: "NASDAQ", workingSchedules: [] }] }, calls),
    });
    const instrument = { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", workingScheduleId: 1 };
    await Promise.all([service.schedules("demo"), service.tryMarketStatus("demo", instrument), service.schedules("demo")]);
    expect(calls).toEqual(["https://demo.test/api/v0/equity/metadata/exchanges"]);
  });

  it("refuses an environment without credentials", async () => {
    const service = new InsightsService({ config, instruments: async () => [], fetcher: fetcherFor({}, []) });
    await expect(service.collect("live", "orders", { to: new Date() })).rejects.toThrow(/LIVE credentials are not configured/);
  });

  it("never sends credentials to a host named by a page path", async () => {
    const calls: string[] = [];
    const service = new InsightsService({
      config,
      instruments: async () => [],
      fetcher: fetcherFor({
        "https://demo.test/api/v0/equity/history/orders?limit=50": { items: [], nextPagePath: "https://evil.test/api/v0/equity/history/orders?cursor=2" },
        "https://demo.test/api/v0/equity/history/orders?cursor=2": { items: [] },
      }, calls),
    });
    await service.collect("demo", "orders", { to: new Date() });
    expect(calls.every((url) => url.startsWith("https://demo.test/"))).toBe(true);
  });
});

describe("window parsing", () => {
  it("builds year-to-date and explicit windows", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(parseWindow({ period: "ytd" }, now).from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseWindow({ period: "all" }, now).from).toBeUndefined();
    expect(() => parseWindow({ from: "2026-12-01T00:00:00Z" }, now)).toThrow(/before to/);
  });

  it("covers the whole last day of a date-only window and supports one week", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(parseWindow({ from: "2026-10-01", to: "2026-10-05" }, now).to.toISOString()).toBe("2026-10-05T23:59:59.999Z");
    expect(parseWindow({ period: "1w" }, now).from?.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(() => parseWindow({ to: "yesterday" }, now)).toThrow(/YYYY-MM-DD/);
  });

  it("rejects calendar dates that do not exist instead of rolling them into the next month", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(() => parseWindow({ from: "2026-02-30", to: "2026-03-05" }, now)).toThrow(/from must be a real date/);
    expect(() => parseWindow({ to: "2026-04-31" }, now)).toThrow(/to must be a real date/);
    expect(() => parseWindow({ from: "2026-02-31T10:00:00Z" }, now)).toThrow(/from must be a real date/);
    expect(parseWindow({ from: "2024-02-29", to: "2024-03-01T08:00:00Z" }, now).from?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
});

describe("tax year summary", () => {
  const service = (calls: string[]) => new InsightsService({
    config,
    instruments: async () => [],
    fetcher: fetcherFor({
      "https://demo.test/api/v0/equity/account/summary": { currency: "GBP", totalValue: 1000 },
      "https://demo.test/api/v0/equity/history/orders?limit=50": { items: [
        { order: { ticker: "VUSAl_EQ", side: "SELL" }, fill: { filledAt: "2026-05-01T10:00:00Z", quantity: -2, walletImpact: { netValue: 180, realisedProfitLoss: -12 } } },
        { order: { ticker: "VUSAl_EQ", side: "SELL" }, fill: { filledAt: "2026-04-01T10:00:00Z", quantity: -1, walletImpact: { netValue: 95, realisedProfitLoss: 7 } } },
      ] },
      "https://demo.test/api/v0/equity/history/dividends?limit=50": { items: [] },
      "https://demo.test/api/v0/equity/history/transactions?limit=50": { items: [] },
    }, calls),
  });

  it("defaults to the latest tax year that has started", async () => {
    const calls: string[] = [];
    const result = await service(calls).taxYear("demo", { yearStart: "04-06" }, new Date("2026-10-01T00:00:00Z"));
    expect(result.year).toBe(2026);
    expect(result.disposals).toEqual({ count: 1, proceeds: 180, gains: 0, losses: -12, net: -12 });
    expect(result.byTicker).toEqual([{ ticker: "VUSAl_EQ", disposals: 1, proceeds: 180, realizedProfitLoss: -12 }]);
    expect(calls.some((url) => url.includes("/equity/history/orders"))).toBe(true);
  });

  it("rejects a start day that does not exist and a year that has not started", async () => {
    await expect(service([]).taxYear("demo", { yearStart: "02-30" })).rejects.toThrow(/yearStart must be a real month and day/);
    await expect(service([]).taxYear("demo", { year: 2027 }, new Date("2026-10-01T00:00:00Z"))).rejects.toThrow(/has not started yet/);
    await expect(service([]).taxYear("demo", { timeZone: "Mars/Olympus" })).rejects.toThrow(/IANA time zone/);
  });
});
