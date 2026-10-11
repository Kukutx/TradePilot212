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
