import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };
const position: Position = { instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 };

/** Fake Trading 212 with a mutable order book and order history. */
function broker() {
  const state = {
    nextId: 100,
    pending: new Map<string, Record<string, unknown>>(),
    history: [] as Array<{ order: { id: number; status: string; filledQuantity?: number; quantity?: number } }>,
    cancels: [] as string[],
    /** HTTP status the next cancels answer with (200 cancels the order). */
    cancelStatus: 200,
    posts: [] as Array<Record<string, unknown>>,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.posts.push(body);
      const order = { id: state.nextId++, ...body };
      state.pending.set(String(order.id), order);
      return json(order);
    }
    if (init?.method === "DELETE") {
      const id = url.pathname.split("/").pop()!;
      state.cancels.push(id);
      if (state.cancelStatus !== 200) return json({ code: "Failed" }, state.cancelStatus);
      state.pending.delete(id);
      return json(null);
    }
    if (url.pathname.endsWith("/equity/metadata/instruments")) return json([instrument]);
    if (url.pathname.endsWith("/equity/positions")) return json([position]);
    if (url.pathname.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 5000, cash: { availableToTrade: 1000 } });
    if (url.pathname.endsWith("/equity/orders")) return json([...state.pending.values()]);
    if (url.pathname.endsWith("/equity/history/orders")) return json({ items: state.history, nextPagePath: null });
    return json([]);
  }) as typeof fetch;
  return { fetcher, state };
}

function setup(env: RuntimeEnv = {}) {
  const fake = broker();
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", T212_LIVE_API_KEY: "k", T212_LIVE_API_SECRET: "s", ...env });
  return { ...createServices({ config, store: new MemoryStateStore(), fetcher: fake.fetcher }), broker: fake.state };
}

async function placePair(services: ReturnType<typeof setup>, environment: "demo" | "live" = "demo") {
  const draft = await services.trading.protectiveBasket(environment, "VUSA", { stopLossPrice: 90, takeProfitPrice: 120 });
  const preview = await services.trading.prepareBasket({ environment, purpose: "protective", title: draft.title, drafts: draft.legs.map((leg) => leg.draft), independentSells: true });
  return services.trading.executeBasket(preview.token, { liveAcknowledged: true });
}

describe("linked protective orders", () => {
  it("cancels the take-profit once the stop-loss has filled", async () => {
    const services = setup();
    await placePair(services);
    expect(await services.links.list()).toHaveLength(1);
    expect((await services.links.reconcile())).toEqual([]);

    services.broker.pending.delete("100");
    services.broker.history.push({ order: { id: 100, status: "FILLED", filledQuantity: 10 } });
    const [report] = await services.links.reconcile();
    expect(report?.action).toBe("cancelled_sibling");
    expect(services.broker.cancels).toEqual(["101"]);
    expect(await services.links.list()).toHaveLength(0);
  });

  it("leaves the other order alone when one was cancelled without a fill", async () => {
    const services = setup();
    await placePair(services);
    services.broker.pending.delete("101");
    services.broker.history.push({ order: { id: 101, status: "CANCELLED" } });
    expect((await services.links.reconcile())[0]?.action).toBe("unlinked");
    expect(services.broker.cancels).toEqual([]);
    expect(services.broker.pending.has("100")).toBe(true);
  });

  it("waits while the missing order is not in the history yet", async () => {
    const services = setup();
    await placePair(services);
    services.broker.pending.delete("100");
    expect((await services.links.reconcile())[0]?.action).toBe("waiting");
    expect(services.broker.cancels).toEqual([]);
    expect(await services.links.list()).toHaveLength(1);
  });

  it("leaves the other order for you when one filled only partly", async () => {
    const services = setup();
    await placePair(services);
    services.broker.pending.delete("100");
    services.broker.history.push({ order: { id: 100, status: "CANCELLED", filledQuantity: -4, quantity: -10 } });
    expect((await services.links.reconcile())[0]?.action).toBe("unlinked");
    expect(services.broker.cancels).toEqual([]);
    expect(services.broker.pending.has("101")).toBe(true);
    const attention = (await services.trading.getActivity("demo")).filter((event) => event.type === "protective_attention");
    expect(attention[0]?.outcome).toMatch(/filled 4 of 10/);
  });

  it("tries a failed cancel again on later ticks, then reports it", async () => {
    const services = setup();
    await placePair(services);
    services.broker.pending.delete("100");
    services.broker.history.push({ order: { id: 100, status: "FILLED", filledQuantity: 10 } });
    services.broker.cancelStatus = 400;
    for (let tick = 1; tick < 5; tick++) {
      expect((await services.links.reconcile())[0]?.action).toBe("cancel_unclear");
      expect(await services.links.list()).toHaveLength(1);
    }
    expect((await services.links.reconcile())[0]?.message).toMatch(/kept failing/);
    expect(services.broker.cancels).toHaveLength(5);
    expect(await services.links.list()).toHaveLength(0);
    expect((await services.trading.getActivity("demo")).some((event) => event.type === "protective_attention")).toBe(true);
  });

  it("treats a sibling that is already gone as done", async () => {
    const services = setup();
    await placePair(services);
    services.broker.pending.delete("100");
    services.broker.history.push({ order: { id: 100, status: "FILLED", filledQuantity: 10 } });
    services.broker.cancelStatus = 404;
    const [report] = await services.links.reconcile();
    expect(report).toMatchObject({ action: "cancelled_sibling" });
    expect(report?.message).toMatch(/no longer pending/);
    expect(await services.links.list()).toHaveLength(0);
  });

  it("does not link when PROTECTIVE_OCO=false", async () => {
    const services = setup({ PROTECTIVE_OCO: "false" });
    await placePair(services);
    expect(await services.links.list()).toHaveLength(0);
  });
});

describe("Live second confirmation", () => {
  it("keeps the token when the Live acknowledgement is missing", async () => {
    const services = setup({ POLICY_APPLY_TO: "none" });
    const preview = await services.trading.prepareOrder({ environment: "live", ticker: "VUSA_EQ", side: "sell", type: "limit", quantity: 1, limitPrice: 120 });
    await expect(services.trading.executeOrder(preview.token)).rejects.toMatchObject({ code: "LIVE_ACK_REQUIRED" });
    expect(services.broker.posts).toHaveLength(0);
    expect((await services.trading.executeOrder(preview.token, { liveAcknowledged: true })).ok).toBe(true);
  });

  it("requires it for Live baskets but not for Demo", async () => {
    const services = setup({ POLICY_APPLY_TO: "none" });
    const drafts = [{ environment: "live" as const, ticker: "VUSA_EQ", side: "sell" as const, type: "limit" as const, quantity: 1, limitPrice: 120 }];
    const live = await services.trading.prepareBasket({ environment: "live", purpose: "custom", title: "x", drafts });
    await expect(services.trading.executeBasket(live.token)).rejects.toMatchObject({ code: "LIVE_ACK_REQUIRED" });
    const demo = await services.trading.prepareBasket({ environment: "demo", purpose: "custom", title: "x", drafts: drafts.map((draft) => ({ ...draft, environment: "demo" as const })) });
    expect((await services.trading.executeBasket(demo.token)).status).toBe("submitted");
  });
});
