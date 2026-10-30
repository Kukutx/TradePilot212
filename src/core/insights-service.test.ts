import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { InsightsService, parseWindow } from "./insights-service.js";
import { resetLimits } from "./rate-limit.js";
import { HistoryLedgers, MAX_CHUNKS } from "./history-ledger.js";
import { MemoryStateStore } from "./state-store.js";

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

  it("gives the pages read, truncated and not kept, when the limit resets later than a read waits", async () => {
    resetLimits();
    const calls: string[] = [];
    // Trading 212 says the second page used the last request until an hour from now.
    const limited = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 3600) };
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      const n = Number(new URL(url).searchParams.get("cursor") ?? 1);
      return Response.json({ items: [{ dateTime: "2026-09-01T00:00:00Z", amount: n }], nextPagePath: `/api/v0/equity/history/transactions?cursor=${n + 1}` }, { headers: n === 2 ? limited : {} });
    }) as typeof fetch;
    const service = new InsightsService({ config, instruments: async () => [], fetcher });
    const result = await service.collect("demo", "transactions", { to: new Date() }, 5);
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(2);
    // Not kept: the next read asks again (and, the limit still used up, is refused on its first page).
    await expect(service.collect("demo", "transactions", { to: new Date() }, 5)).rejects.toThrow(/used up until/);
    expect(calls).toHaveLength(2);
    resetLimits();
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

describe("history ledger", () => {
  /** A Trading 212 fake with `count` cash movements a day apart, newest first, 50 a page; `add` puts newer ones on top. */
  function broker(count: number) {
    const day = 86_400_000;
    const base = Date.parse("2026-10-01T00:00:00Z");
    let items = Array.from({ length: count }, (_, index) => ({ reference: `t${count - index}`, type: "DEPOSIT", amount: count - index, currency: "EUR", dateTime: new Date(base - index * day).toISOString() }));
    const calls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = items.slice(offset, offset + 50);
      return Response.json({ items: page, nextPagePath: offset + 50 < items.length ? `/api/v0/equity/history/transactions?limit=50&cursor=${offset + 50}` : null });
    }) as typeof fetch;
    const add = (n: number) => {
      const top = Number(items[0]!.reference.slice(1));
      items = [...Array.from({ length: n }, (_, index) => ({ reference: `t${top + n - index}`, type: "DEPOSIT", amount: top + n - index, currency: "EUR", dateTime: new Date(base + (n - index) * day).toISOString() })), ...items];
    };
    return { fetcher, calls, add };
  }
  const withLedger = (fetcher: typeof fetch, store = new MemoryStateStore()) => ({ store, service: new InsightsService({ config, instruments: async () => [], fetcher, ledgers: new HistoryLedgers(store) }) });
  const all = { to: new Date("2027-01-01T00:00:00Z") };

  it("keeps what each read reads, so reads go on further back until the whole history is kept", async () => {
    const { fetcher, calls } = broker(230);
    const { store } = withLedger(fetcher);
    // A fresh service each time, as each call reads afresh after the minute's cache.
    const read = () => withLedger(fetcher, store).service.collect("demo", "transactions", all, 2);
    const first = await read();
    expect(first.items).toHaveLength(100);
    expect(first.truncated).toBe(true);
    // The newest page reaches a record kept at once; the budget left goes on from where the last read stopped.
    const second = await read();
    expect(second.items).toHaveLength(150);
    expect(calls.slice(2)).toEqual(["/api/v0/equity/history/transactions?limit=50", "/api/v0/equity/history/transactions?limit=50&cursor=100"]);
    await read();
    const whole = await read();
    expect(whole.items).toHaveLength(230);
    expect(whole.truncated).toBe(false);
    expect(new Set(whole.items.map((item) => item.reference)).size).toBe(230);
    // Whole: one page, the newest, is all a read asks for now.
    const before = calls.length;
    await read();
    expect(calls.length - before).toBe(1);
  });

  it("adds the records newer than the newest kept, and starts again when more came in than a read reaches", async () => {
    const { fetcher, add } = broker(60);
    const { store } = withLedger(fetcher);
    const read = (pages = 5) => withLedger(fetcher, store).service.collect("demo", "transactions", all, pages);
    expect((await read()).items).toHaveLength(60);
    add(3);
    const updated = await read();
    expect(updated.items.map((item) => item.reference).slice(0, 4)).toEqual(["t63", "t62", "t61", "t60"]);
    expect(updated.items).toHaveLength(63);
    expect(updated.truncated).toBe(false);
    // 120 new ones and a budget of two pages: whether records were missed between them and what is kept is not
    // known, so nothing is added, and both are returned as cut short; a read that reaches far enough adds them.
    add(120);
    const short = await read(2);
    expect(short.items).toHaveLength(163);
    expect(short.truncated).toBe(true);
    expect(short.items[0]!.reference).toBe("t183");
    const reached = await read(5);
    expect(reached.items).toHaveLength(183);
    expect(reached.truncated).toBe(false);
  });

  it("returns the window's records, and reads no further back than its start", async () => {
    const { fetcher, calls } = broker(400);
    const { service } = withLedger(fetcher);
    const result = await service.collect("demo", "transactions", { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z") }, 10);
    expect(result.items).toHaveLength(123);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("adds each read's new records as a chunk of its own, merges them past a number, and loses nothing to two writers at once", async () => {
    const { fetcher, add } = broker(450);
    const { store } = withLedger(fetcher);
    const read = () => withLedger(fetcher, store).service.collect("demo", "transactions", all, 10);
    await read();
    const short = (key: string) => key.replace(/^ledger:demo:[0-9a-f]+:transactions:/, "").replace(/^c:.*/, "c");
    expect((await store.list<unknown[]>("ledger:demo:")).map((entry) => short(entry.key))).toEqual(["c", "meta"]);
    // The account is named by a digest, never by its key.
    expect((await store.list("ledger:")).some((entry) => entry.key.includes("key"))).toBe(false);
    const writes: string[] = [];
    const put = store.put.bind(store);
    store.put = async (key, value, expiresAt) => { writes.push(short(key)); return put(key, value, expiresAt); };
    add(1);
    expect((await read()).items).toHaveLength(451);
    expect(writes).toEqual(["c", "meta"]);
    // Two processes reading at once, each adding what it found new: the union keeps both.
    add(2);
    const [a, b] = await Promise.all([read(), read()]);
    expect(a.items).toHaveLength(453);
    expect(b.items).toHaveLength(453);
    expect((await read()).items).toHaveLength(453);
    // Many chunks are merged into one.
    for (let index = 0; index < MAX_CHUNKS; index += 1) { add(1); await read(); }
    const chunks = (await store.list("ledger:demo:")).filter((entry) => short(entry.key) === "c");
    expect(chunks.length).toBeLessThan(MAX_CHUNKS);
    expect((await read()).items).toHaveLength(453 + MAX_CHUNKS);
  });

  it("picks up an order made before the newest kept that filled since, by reading down to the oldest one open", async () => {
    const day = 86_400_000;
    const at = (days: number) => new Date(Date.parse("2026-10-01T00:00:00Z") - days * day).toISOString();
    // A limit order made 40 days ago, open until it fills; the others filled the day they were made.
    let open = true;
    const filled = (id: number, days: number) => ({ order: { id, ticker: "X", createdAt: at(days) }, fill: { id: id * 10, filledAt: at(days) } });
    const others = Array.from({ length: 120 }, (_, index) => filled(1000 - index, index));
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/equity/orders")) return Response.json(open ? [{ id: 7, ticker: "X", createdAt: at(40) }] : []);
      // Trading 212 places an order by when it was made.
      const items = [...others, ...(open ? [] : [{ order: { id: 7, ticker: "X", createdAt: at(40) }, fill: { id: 70, filledAt: at(0) } }])]
        .sort((a, b) => Date.parse(b.order.createdAt) - Date.parse(a.order.createdAt));
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      return Response.json({ items: items.slice(offset, offset + 50), nextPagePath: offset + 50 < items.length ? `/api/v0/equity/history/orders?limit=50&cursor=${offset + 50}` : null });
    }) as typeof fetch;
    const store = new MemoryStateStore();
    const read = () => withLedger(fetcher, store).service.collect("demo", "orders", all, 5);
    expect((await read()).items).toHaveLength(120);
    open = false;
    const after = await read();
    expect(after.items).toHaveLength(121);
    expect(after.items.some((item) => item.order?.id === 7)).toBe(true);
  });

  it("starts the ledger again when Trading 212 refuses the way back, rather than fail every read", async () => {
    const { fetcher: base } = broker(200);
    let refuse = false;
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (refuse && String(input).includes("cursor=")) return new Response(JSON.stringify({ code: "BadCursor" }), { status: 400 });
      return base(input, init);
    }) as typeof fetch;
    const { store } = withLedger(fetcher);
    const read = () => withLedger(fetcher, store).service.collect("demo", "transactions", all, 2);
    await read();
    refuse = true;
    const refused = await read();
    expect(refused.truncated).toBe(true);
    expect(refused.items).toHaveLength(100);
    expect(await store.get(`${(await store.list("ledger:"))[0]?.key ?? "none"}`)).toBeUndefined();
    refuse = false;
    expect((await read()).items).toHaveLength(100);
  });

  it("reads one instrument's from Trading 212's own filter until the ledger reaches back far enough", async () => {
    const calls: string[] = [];
    const order = (id: number, ticker: string, filledAt: string) => ({ order: { id, ticker }, fill: { id: id * 10, filledAt } });
    const items = [order(3, "AAPL_US_EQ", "2026-09-03T00:00:00Z"), order(2, "MSFT_US_EQ", "2026-09-02T00:00:00Z"), order(1, "AAPL_US_EQ", "2026-09-01T00:00:00Z")];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url.search);
      const ticker = url.searchParams.get("ticker");
      return Response.json({ items: ticker ? items.filter((item) => item.order.ticker === ticker) : items, nextPagePath: null });
    }) as typeof fetch;
    const store = new MemoryStateStore();
    const read = () => new InsightsService({ config, instruments: async () => [], fetcher, ledgers: new HistoryLedgers(store) }).collect("demo", "orders", all, 5, "AAPL_US_EQ");
    expect((await read()).items).toHaveLength(2);
    expect(calls).toEqual(["?limit=50&ticker=AAPL_US_EQ"]);
    // A read of all of them keeps the whole history; one instrument's then comes from it.
    await new InsightsService({ config, instruments: async () => [], fetcher, ledgers: new HistoryLedgers(store) }).collect("demo", "orders", all, 5);
    const fromLedger = await read();
    expect(fromLedger.items.map((item) => item.order?.id)).toEqual([3, 1]);
    expect(calls.at(-1)).toBe("?limit=50");
  });
});
