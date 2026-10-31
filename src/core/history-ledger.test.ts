import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryOrderItem } from "../shared/history.js";
import type { RuntimeConfig } from "./config.js";
import { HistoryLedgers } from "./history-ledger.js";
import { InsightsService } from "./insights-service.js";
import { resetLimits } from "./rate-limit.js";
import { MemoryStateStore } from "./state-store.js";

const config = {
  trading212: {
    demo: { baseUrl: "https://demo.test/api/v0", apiKey: "key", apiSecret: "secret" },
    live: { baseUrl: "https://live.test/api/v0", apiKey: "", apiSecret: "" },
  },
} as RuntimeConfig;

const DAY = 86_400_000;
const T0 = Date.parse("2026-06-01T12:00:00Z");
const iso = (time: number) => new Date(time).toISOString();
const service = (fetcher: typeof fetch, store: MemoryStateStore) => new InsightsService({ config, instruments: async () => [], fetcher, ledgers: new HistoryLedgers(store) });
const metaOf = async (store: MemoryStateStore) => (await store.list<{ segments: Array<{ next: string | null }> }>("ledger:")).find((entry) => entry.key.endsWith("meta"))!.value;

/** Cash movements with a cursor by time (`before`), newest first, 50 a page; a cursor in `refused` is answered 404 once. */
function cashBroker() {
  const items: Array<{ reference: string; type: string; amount: number; currency: string; dateTime: string }> = [];
  const refused = new Set<string>();
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const before = url.searchParams.get("before");
    // A path that went stale is refused; the same one read afresh works.
    if (before && refused.delete(before)) return new Response("gone", { status: 404 });
    const sorted = [...items].sort((a, b) => Date.parse(b.dateTime) - Date.parse(a.dateTime));
    const rest = before ? sorted.filter((item) => Date.parse(item.dateTime) < Number(before)) : sorted;
    const page = rest.slice(0, 50);
    return Response.json({ items: page, nextPagePath: rest.length > 50 ? `/api/v0/equity/history/transactions?limit=50&before=${Date.parse(page.at(-1)!.dateTime)}` : null });
  }) as typeof fetch;
  const add = (times: number[]) => { for (const time of times) items.push({ reference: `t${items.length + 1}`, type: "DEPOSIT", amount: 1, currency: "EUR", dateTime: iso(time) }); };
  return { fetcher, add, refused, items };
}

/** Orders placed by when they were made, a cursor after an item; `open` is what is open, `emptyOnce` answers one page empty. */
function orderBroker() {
  const items: HistoryOrderItem[] = [];
  const state = { open: [] as Array<{ id: number; ticker: string; createdAt: string }>, emptyOnce: false, tickers: [] as string[] };
  const tag = (item: HistoryOrderItem) => `${item.order?.id}-${item.fill?.id ?? ""}`;
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/equity/orders")) return Response.json(state.open);
    if (state.emptyOnce) { state.emptyOnce = false; return Response.json({ items: [], nextPagePath: null }); }
    const ticker = url.searchParams.get("ticker");
    if (ticker) state.tickers.push(ticker);
    const sorted = items.filter((item) => !ticker || item.order?.ticker === ticker)
      .sort((a, b) => Date.parse(b.order!.createdAt!) - Date.parse(a.order!.createdAt!) || Number(b.fill?.id ?? 0) - Number(a.fill?.id ?? 0));
    const after = url.searchParams.get("after");
    const from = after ? sorted.findIndex((item) => tag(item) === after) + 1 : 0;
    const page = sorted.slice(from, from + 50);
    return Response.json({ items: page, nextPagePath: from + 50 < sorted.length ? `/api/v0/equity/history/orders?limit=50${ticker ? `&ticker=${ticker}` : ""}&after=${tag(page.at(-1)!)}` : null });
  }) as typeof fetch;
  const fill = (id: number, ticker: string, createdAt: number, fillId = id * 10, filledAt = createdAt) =>
    items.push({ order: { id, ticker, createdAt: iso(createdAt) }, fill: { id: fillId, filledAt: iso(filledAt) } });
  return { fetcher, fill, state, items };
}

describe("history ledger runs", () => {
  afterEach(() => { vi.useRealTimers(); resetLimits(); });

  it("does not take older runs as joined to the newest records when the way down from them is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const broker = cashBroker();
    broker.add(Array.from({ length: 300 }, (_, index) => T0 - (index + 1) * DAY));
    const store = new MemoryStateStore();
    const to = new Date(T0 + 400 * DAY);
    expect((await service(broker.fetcher, store).collect("demo", "transactions", { from: new Date(T0 - 90 * DAY), to }, 2)).truncated).toBe(false);
    // 200 new ones a month later, more than two pages: a run of their own, apart from the one below.
    vi.setSystemTime(T0 + 30 * DAY);
    broker.add(Array.from({ length: 200 }, (_, index) => T0 + 30 * DAY - (index + 1) * 2 * 3_600_000));
    expect((await service(broker.fetcher, store).collect("demo", "transactions", { from: new Date(T0 - 60 * DAY), to }, 2)).truncated).toBe(true);
    const meta = await metaOf(store);
    expect(meta.segments).toHaveLength(2);
    // The way down from the newest run goes stale: what lies between the runs is still not read.
    broker.refused.add(new URL(`https://x${meta.segments[0]!.next}`).searchParams.get("before")!);
    vi.setSystemTime(T0 + 31 * DAY);
    const window = { from: new Date(T0 - 59 * DAY), to };
    const refused = await service(broker.fetcher, store).collect("demo", "transactions", window, 5);
    expect(refused.truncated).toBe(true);
    // What it returns is the newest records without a hole: none from the older run below what was not read.
    const newest = [...broker.items].sort((a, b) => Date.parse(b.dateTime) - Date.parse(a.dateTime)).map((item) => item.reference);
    expect(refused.items.map((item) => item.reference)).toEqual(newest.slice(0, refused.items.length));
    // Later reads read down past it.
    let result = refused;
    for (let tries = 0; tries < 4 && result.truncated; tries += 1) result = await service(broker.fetcher, store).collect("demo", "transactions", window, 5);
    const start = Math.floor(window.from.getTime() / DAY) * DAY;
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(broker.items.filter((item) => Date.parse(item.dateTime) >= start).length);
  });

  it("does not take an empty answer as the end of the history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const broker = orderBroker();
    for (let index = 0; index < 300; index += 1) broker.fill(1000 + index, "X", T0 - (index + 1) * DAY);
    const store = new MemoryStateStore();
    const all = { to: new Date(T0 + 400 * DAY) };
    await service(broker.fetcher, store).collect("demo", "orders", all, 2);
    vi.setSystemTime(T0 + 30 * DAY);
    for (let index = 0; index < 200; index += 1) broker.fill(5000 + index, "X", T0 + 30 * DAY - (index + 1) * 2 * 3_600_000);
    expect((await service(broker.fetcher, store).collect("demo", "orders", all, 2)).truncated).toBe(true);
    vi.setSystemTime(T0 + 30 * DAY + 3_600_000);
    broker.state.emptyOnce = true;
    expect((await service(broker.fetcher, store).collect("demo", "orders", all, 2)).truncated).toBe(true);
    let result = await service(broker.fetcher, store).collect("demo", "orders", all, 10);
    for (let tries = 0; tries < 4 && result.truncated; tries += 1) result = await service(broker.fetcher, store).collect("demo", "orders", all, 10);
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(500);
  });

  it("takes an empty history as whole, and an empty page after a full last one as its end", async () => {
    const store = new MemoryStateStore();
    let pages = 0;
    const empty = (async () => { pages += 1; return Response.json({ items: [], nextPagePath: null }); }) as typeof fetch;
    const all = { to: new Date(Date.now() + 400 * DAY) };
    for (let read = 0; read < 3; read += 1) expect((await service(empty, store).collect("demo", "dividends", all, 10)).truncated).toBe(false);
    expect(pages).toBe(3);
    expect((await metaOf(store)).segments).toHaveLength(1);
    // A path after a full last page that leads to nothing.
    const full = (async (input: URL | RequestInfo) => {
      const after = new URL(String(input)).searchParams.get("cursor");
      const items = after ? [] : Array.from({ length: 50 }, (_, index) => ({ reference: `d${index}`, ticker: "X", amount: 1, paidOn: iso(Date.now() - (index + 10) * DAY) }));
      return Response.json({ items, nextPagePath: after ? null : "/api/v0/equity/history/dividends?limit=50&cursor=50" });
    }) as typeof fetch;
    const other = new MemoryStateStore();
    for (let read = 0; read < 3; read += 1) {
      const result = await service(full, other).collect("demo", "dividends", all, 10);
      expect(result.truncated).toBe(false);
      expect(result.items).toHaveLength(50);
    }
  });

  it("finds every fill of an order that closed since, though they run onto its instrument's next page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const broker = orderBroker();
    for (let index = 0; index < 200; index += 1) broker.fill(1000 + index, "X", T0 - (index + 1) * 12 * 3_600_000);
    for (let index = 0; index < 49; index += 1) broker.fill(2000 + index, "Y", T0 - (index + 1) * 2 * DAY + 1000);
    broker.state.open = [{ id: 7, ticker: "Y", createdAt: iso(T0 - 110 * DAY) }];
    const store = new MemoryStateStore();
    const to = new Date(T0 + 400 * DAY);
    expect((await service(broker.fetcher, store).collect("demo", "orders", { from: new Date(T0 - 100 * DAY), to }, 10)).truncated).toBe(false);
    // Order 7 fills in two parts and closes: its 50th and 51st records in Y's history.
    vi.setSystemTime(T0 + DAY);
    broker.fill(7, "Y", T0 - 110 * DAY, 71, T0 + DAY / 2);
    broker.fill(7, "Y", T0 - 110 * DAY, 70, T0 + DAY / 3);
    broker.state.open = [];
    const result = await service(broker.fetcher, store).collect("demo", "orders", { from: new Date(T0 + DAY - 100 * DAY), to }, 10);
    expect(result.items.filter((item) => item.order?.id === 7).map((item) => item.fill?.id).sort()).toEqual([70, 71]);
    expect(result.truncated).toBe(false);
    expect(broker.state.tickers).toEqual(["Y", "Y"]);
  });

  it("marks the history cut short while an order no longer open is not listed yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const broker = orderBroker();
    for (let index = 0; index < 60; index += 1) broker.fill(1000 + index, "X", T0 - (index + 1) * DAY);
    broker.state.open = [{ id: 7, ticker: "Y", createdAt: iso(T0 - 20 * DAY) }];
    const store = new MemoryStateStore();
    const all = { to: new Date(T0 + 400 * DAY) };
    await service(broker.fetcher, store).collect("demo", "orders", all, 10);
    broker.state.open = [];
    vi.setSystemTime(T0 + 3_600_000);
    expect((await service(broker.fetcher, store).collect("demo", "orders", all, 10)).truncated).toBe(true);
    broker.fill(7, "Y", T0 - 20 * DAY, 70, T0 + 3_600_000);
    vi.setSystemTime(T0 + 2 * 3_600_000);
    const listed = await service(broker.fetcher, store).collect("demo", "orders", all, 10);
    expect(listed.truncated).toBe(false);
    expect(listed.items).toHaveLength(61);
  });

  it("keeps a recent fill of an old order when the oldest records go", async () => {
    const store = new MemoryStateStore();
    const ledgers = new HistoryLedgers(store, { maxRecords: 10_000 });
    const place = (item: HistoryOrderItem) => Math.min(Date.parse(item.order!.createdAt!), Date.parse(item.fill!.filledAt!));
    const times = { time: (item: HistoryOrderItem) => Date.parse(item.fill!.filledAt!), place };
    const records: HistoryOrderItem[] = Array.from({ length: 10_000 }, (_, index) => ({ order: { id: index, ticker: "X", createdAt: iso(T0 - (index + 1) * 3_600_000) }, fill: { id: index * 10, filledAt: iso(T0 - (index + 1) * 3_600_000) } }));
    const late = { order: { id: 99_999, ticker: "Y", createdAt: iso(T0 - 600 * DAY) }, fill: { id: 1, filledAt: iso(T0 - DAY) } };
    const segment = { readAt: iso(T0), bottom: iso(T0 - 10_000 * 3_600_000), next: null, complete: true };
    const { items, meta } = await ledgers.add("p:", "orders", undefined, [late, ...records], { segments: [segment], pending: [] }, times);
    expect(items).toContain(late);
    expect(items.length).toBeLessThan(10_000);
    expect(meta.segments[0]).toMatchObject({ complete: false, next: null });
    // Another process writing the runs from what it loaded before the cut cannot claim the records cut away.
    await store.put("p:meta", { ...meta, segments: [segment] });
    const loaded = await ledgers.load("p:", "orders", times);
    expect(loaded!.meta.segments[0]!.complete).toBe(false);
    expect(Date.parse(loaded!.meta.segments[0]!.bottom!)).toBeGreaterThan(T0 - 10_000 * 3_600_000);

    // A higher limit set since opens the way back: the floor goes, and so does the run that stopped at it, so the
    // next read walks down past it; the records stay.
    const roomier = new HistoryLedgers(store, { maxRecords: 25_000 });
    const before = await roomier.load("p:", "orders", times);
    const fresh = { order: { id: 100_000, ticker: "Z", createdAt: iso(T0) }, fill: { id: 2, filledAt: iso(T0) } };
    const reopened = await roomier.add("p:", "orders", before, [fresh], { segments: before!.meta.segments, pending: [] }, times);
    expect(await store.get("p:floor")).toBeUndefined();
    expect(reopened.meta.segments).toEqual([]);
    expect(reopened.items.length).toBe(items.length + 1);
  });
});
