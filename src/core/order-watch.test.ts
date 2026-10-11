import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { describeOutcome, isFinal, MAX_MISSING_CHECKS, ORDER_WATCH_INTERVAL_MS, recentFillCount } from "./order-watch.js";
import { MemoryStateStore } from "./state-store.js";

type HistoryItem = { order: Record<string, unknown>; fill?: Record<string, unknown> };

/** Fake Trading 212 with an order book and order history the test changes between checks. */
function setup(env: RuntimeEnv = {}) {
  const state = { pending: new Map<string, Record<string, unknown>>(), history: [] as HistoryItem[], historyReads: 0, failHistory: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname.endsWith("/equity/orders")) return json([...state.pending.values()]);
    if (url.pathname.endsWith("/equity/history/orders")) {
      state.historyReads++;
      return state.failHistory ? json({ code: "Busy" }, 400) : json({ items: state.history, nextPagePath: null });
    }
    return json([]);
  }) as typeof fetch;
  const store = new MemoryStateStore();
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", ...env });
  const services = createServices({ config, store, fetcher });
  const events = async () => (await store.list<ActivityEvent>("activity:")).map((entry) => entry.value).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { services, state, store, events };
}

const limitBuy = { id: 501, ticker: "AAPL_US_EQ", type: "LIMIT", quantity: 5, limitPrice: 180, status: "NEW", createdAt: "2026-10-10T09:00:00Z" };
const at = (minutes: number) => new Date(Date.parse("2026-10-11T12:00:00Z") + minutes * 60_000);

describe("order watch", () => {
  it("only records the open orders on its first check", async () => {
    const { services, state, events } = setup();
    state.pending.set("501", limitBuy);
    expect(await services.orders.check(at(0))).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("reports a fill with its average price and value once the order leaves the book", async () => {
    const { services, state, store, events } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    state.history.push(
      { order: { ...limitBuy, status: "FILLED", filledQuantity: 5 }, fill: { quantity: 2, price: 179.5, filledAt: "2026-10-11T12:01:00Z", walletImpact: { netValue: 330.1, currency: "EUR" } } },
      { order: { ...limitBuy, status: "FILLED", filledQuantity: 5 }, fill: { quantity: 3, price: 180, filledAt: "2026-10-11T12:02:00Z", walletImpact: { netValue: 496.8, currency: "EUR" } } },
    );
    const [report] = await services.orders.check(at(5));
    expect(report).toMatchObject({ orderId: "501", ticker: "AAPL_US_EQ", result: "filled" });
    expect(report!.message).toBe("Filled 5 at 179.8 (826.90 EUR).");
    const [event] = await events();
    expect(event).toMatchObject({ type: "order_filled", ticker: "AAPL_US_EQ", orderId: "501", side: "buy", orderType: "limit", quantity: 5, outcome: "Filled 5 at 179.8 (826.90 EUR)." });
    // The facts behind the sentence, for the widget.
    expect(event).toMatchObject({ filledQuantity: 5, price: 179.8, value: 826.9, valueCurrency: "EUR" });
    expect(await recentFillCount(store, "demo", at(6))).toBe(1);
    expect(await recentFillCount(store, "demo", at(6 + 24 * 60))).toBe(0);
  });

  it("adds up fill rows when the order row does not give the filled total", async () => {
    const { services, state } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    const order = { id: 501, ticker: "AAPL_US_EQ", status: "FILLED", quantity: 5 };
    state.history.push({ order, fill: { quantity: 2, price: 179 } }, { order, fill: { quantity: 3, price: 180 } });
    const [report] = await services.orders.check(at(5));
    expect(report).toMatchObject({ result: "filled", message: "Filled 5 at 179.6." });
  });

  it("waits while the history still shows an earlier state of the order", async () => {
    const { services, state, events } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    state.history.push({ order: { ...limitBuy, status: "PARTIALLY_FILLED", filledQuantity: 2 }, fill: { quantity: 2, price: 179 } });
    expect(await services.orders.check(at(5))).toEqual([]);
    state.history = [{ order: { ...limitBuy, status: "FILLED", filledQuantity: 5 }, fill: { quantity: 5, price: 179 } }];
    expect((await services.orders.check(at(10)))[0]?.result).toBe("filled");
    expect((await events()).map((event) => event.type)).toEqual(["order_filled"]);
  });

  it("tells a partial fill and a cancellation apart, and reads sells from negative quantities", async () => {
    const { services, state, events } = setup();
    state.pending.set("601", { id: 601, ticker: "KO_US_EQ", type: "STOP", quantity: -10, stopPrice: 55, createdAt: "2026-10-11T08:00:00Z" });
    state.pending.set("602", { id: 602, ticker: "MSFT_US_EQ", type: "LIMIT", quantity: 1, limitPrice: 300, createdAt: "2026-10-11T08:00:00Z" });
    await services.orders.check(at(0));
    state.pending.clear();
    state.history.push(
      { order: { id: 601, ticker: "KO_US_EQ", status: "CANCELLED", quantity: -10, filledQuantity: -4 }, fill: { quantity: -4, price: 54.9 } },
      { order: { id: 602, ticker: "MSFT_US_EQ", status: "CANCELLED", quantity: 1 } },
    );
    const reports = await services.orders.check(at(5));
    expect(reports.map((report) => [report.orderId, report.result])).toEqual([["601", "partly_filled"], ["602", "closed"]]);
    expect(reports[0]!.message).toBe("Filled 4 of 10 at 54.9; the rest closed (CANCELLED).");
    const types = (await events()).map((event) => [event.type, event.side]);
    expect(types).toEqual(expect.arrayContaining([["order_partly_filled", "sell"], ["order_closed", "buy"]]));
  });

  it("checks about every 5 minutes and reads the history only when an order left", async () => {
    const { services, state } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    await services.orders.check(at(5));
    expect(state.historyReads).toBe(0);
    state.pending.delete("501");
    state.history.push({ order: { ...limitBuy, status: "FILLED", filledQuantity: 5 } });
    // Inside the same window nothing is read.
    expect(await services.orders.check(at(5 + ORDER_WATCH_INTERVAL_MS / 60_000 - 1))).toEqual([]);
    expect(state.historyReads).toBe(0);
    expect(await services.orders.check(at(10))).toHaveLength(1);
    expect(state.historyReads).toBe(1);
    // Reported once: the order is no longer watched.
    expect(await services.orders.check(at(15))).toEqual([]);
  });

  it("waits for a lagging history, then reports the order as unclear", async () => {
    const { services, state, events } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    for (let check = 1; check < MAX_MISSING_CHECKS; check++) expect(await services.orders.check(at(check * 5))).toEqual([]);
    const [report] = await services.orders.check(at(MAX_MISSING_CHECKS * 5));
    expect(report?.result).toBe("unclear");
    // Its own type: it reaches the webhook by default and is flagged for a look, unlike a cancellation.
    expect((await events())[0]?.type).toBe("order_outcome_unknown");
  });

  it("reports an order whose history never shows an end as unclear, with what it does show", async () => {
    const { services, state } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    state.history.push({ order: { ...limitBuy, status: "NEW", filledQuantity: 0 } });
    for (let check = 1; check < MAX_MISSING_CHECKS; check++) expect(await services.orders.check(at(check * 5))).toEqual([]);
    const [report] = await services.orders.check(at(MAX_MISSING_CHECKS * 5));
    expect(report).toMatchObject({ result: "unclear", message: "Left the order book, but the order history still shows it as NEW. Check it in Trading 212." });
  });

  it("keeps watching when the history cannot be read", async () => {
    const { services, state } = setup();
    state.pending.set("501", limitBuy);
    await services.orders.check(at(0));
    state.pending.delete("501");
    state.failHistory = true;
    expect(await services.orders.check(at(5))).toEqual([]);
    state.failHistory = false;
    state.history.push({ order: { ...limitBuy, status: "FILLED", filledQuantity: 5 } });
    expect((await services.orders.check(at(10)))[0]?.result).toBe("filled");
  });

  it("does nothing with ORDER_WATCH=false", async () => {
    const { services, state, store } = setup({ ORDER_WATCH: "false" });
    state.pending.set("501", limitBuy);
    expect(await services.orders.check(at(0))).toEqual([]);
    expect(await store.get("order-watch:demo")).toBeUndefined();
  });

  it("describes fills of orders placed by value", () => {
    const byValue = { id: "1", ticker: "VUSA_EQ", side: "buy" as const, value: 100 };
    expect(describeOutcome(byValue, { status: "FILLED", filledQuantity: 1.23, quantity: 0 })).toEqual({ result: "filled", message: "Filled 1.23." });
    // No share count to compare with: a cancellation after a fill means the rest did not fill.
    expect(describeOutcome(byValue, { status: "CANCELLED", filledQuantity: 0.5, quantity: 0 })).toEqual({ result: "partly_filled", message: "Filled 0.5 before the rest closed (CANCELLED)." });
  });

  it("knows which history states are final", () => {
    expect(["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "REPLACED"].map((status) => isFinal({ status, filledQuantity: 0, quantity: 1 }))).toEqual([true, true, true, true, true]);
    expect(["NEW", "PARTIALLY_FILLED", "CANCELLING", "REPLACING", ""].map((status) => isFinal({ status, filledQuantity: 0, quantity: 1 }))).toEqual([false, false, false, false, false]);
    expect(isFinal({ status: "", filledQuantity: 1, quantity: 1 })).toBe(true);
  });
});
