import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import type { PortfolioToday } from "../shared/today.js";
import { DailyDigest, digestDay, digestText } from "./digest.js";
import { MemoryStateStore } from "./state-store.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };

function setup(env: Record<string, string>) {
  const hooks: string[] = [];
  const total = { value: 2000 };
  const outage = { on: false };
  const hookDown = { on: false };
  const orders: { list: unknown[] } = { list: [] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).host === "hooks.example") {
      if (hookDown.on) return new Response("down", { status: 503 });
      hooks.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response("ok");
    }
    if (url.endsWith("/equity/orders")) return json(orders.list);
    if (url.endsWith("/equity/positions")) return json([{ instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100, walletImpact: { currentValue: 1000, unrealizedProfitLoss: 100 } }]);
    if (url.endsWith("/equity/account/summary") && outage.on) return new Response(JSON.stringify({ code: "Unauthorized" }), { status: 401 });
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: total.value, cash: { availableToTrade: 1000 }, investments: { unrealizedProfitLoss: 100 } });
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", NOTIFY_WEBHOOK_URL: "https://hooks.example/t", ...env });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher }), config, store, hooks, total, outage, hookDown, orders };
}

describe("daily digest", () => {
  it("formats a compact summary", () => {
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, previousTotalValue: 2000, cash: 10, unrealized: -5, positions: [{ ticker: "A", value: 5, profitLoss: 1 }], pendingOrders: 1, duePlans: ["Monthly"], triggeredAlerts: 0 }))
      .toBe("Total 2010 EUR (+10 since the last digest) · cash 10 · unrealized -5 · top: A 5 (+1) · 1 pending order(s) · due plans: Monthly");
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, cash: 10, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, filledOrders: 2, maxDrift: 0.0712 }))
      .toBe("Total 2010 EUR · cash 10 · 2 order(s) filled in the last day · largest drift from targets 7.1 points");
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 10, cash: 0, positions: [], pendingOrders: 1, duePlans: [], triggeredAlerts: 0, uncovered: ["A", "B", "C", "D", "E", "F", "G"] }))
      .toBe("Total 10 EUR · cash 0 · 1 pending order(s) · no full stop-loss: A, B, C, D, E +2");
  });

  it("leads with the holdings' move on their last session and the biggest movers", () => {
    const today: PortfolioToday = {
      kind: "portfolio_today", environment: "demo", accountCurrency: "EUR", timestamp: "2026-10-10T07:00:00Z",
      moves: [
        { ticker: "VUSAl_EQ", shortName: "VUSA", quantity: 40, day: "2026-10-09", change: -0.0233, profitLoss: -103.08 },
        { ticker: "AAPL_US_EQ", shortName: "AAPL", quantity: 12, day: "2026-10-09", change: 0.0393, profitLoss: 96.6 },
        { ticker: "TSLA_US_EQ", quantity: 0, day: "2026-10-09", profitLoss: -27.6, sold: 3 },
        { ticker: "KO_US_EQ", shortName: "KO", quantity: 25, day: "2026-10-09", missing: "lag" },
        { ticker: "MSFT_US_EQ", shortName: "MSFT", quantity: 6, day: "2026-10-09", change: -0.0119, profitLoss: -8.48 },
      ],
      total: { profitLoss: -42.56, change: -0.0085, counted: 4, of: 5 },
    };
    const day = digestDay(today)!;
    expect(day.movers.map((mover) => mover.name)).toEqual(["VUSA", "AAPL", "TSLA_US_EQ"]);
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, cash: 10, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, day }))
      .toBe("Total 2010 EUR · day -42.56 (-0.85%) on 2026-10-09 for 4 of 5 holdings · movers: VUSA -2.33%, AAPL +3.93%, TSLA_US_EQ -27.6 · cash 10");
    expect(digestDay({ ...today, total: undefined })).toBeUndefined();
  });

  it("reads the day for the digest's own time, and goes on without it when it fails", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    const texts: string[] = [];
    const asked: Date[] = [];
    const total = { profitLoss: 12.5, change: 0.0125, counted: 1, of: 1 };
    const moves = [{ ticker: "VUSA_EQ", shortName: "VUSA", quantity: 10, day: "2026-10-09", change: 0.0125, profitLoss: 12.5 }];
    let fail = false;
    const digest = new DailyDigest({
      config: services.config, store: services.store, trading: services.trading,
      notify: async (event) => { texts.push(event.outcome ?? ""); return true; },
      today: async (environment, now) => {
        asked.push(now);
        if (fail) throw new Error("rate limit");
        return { kind: "portfolio_today", environment, accountCurrency: "EUR", moves, total, timestamp: now.toISOString() };
      },
    });
    expect(await digest.run(new Date("2026-10-10T07:00:00Z"))).toEqual(["demo"]);
    expect(asked.map((date) => date.toISOString())).toEqual(["2026-10-10T07:00:00.000Z"]);
    expect(texts[0]).toMatch(/^Total 2000 EUR · day \+12\.5 \(\+1\.25%\) on 2026-10-09 · movers: VUSA \+1\.25% · cash 1000/);
    fail = true;
    expect(await digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(texts[1]).toBe("Total 2000 EUR (+0 since the last digest) · cash 1000 · unrealized +100 · top: VUSA_EQ 1000 (+100)");
  });

  it("names holdings a stop does not fully cover, once any stop is in place", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    expect(await services.digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[0]).not.toMatch(/stop-loss/);
    services.orders.list = [{ id: 7, ticker: "VUSA_EQ", type: "STOP", side: "SELL", quantity: -4, stopPrice: 90, status: "NEW" }];
    expect(await services.digest.run(new Date("2026-10-12T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[1]).toMatch(/· no full stop-loss: VUSA_EQ$/);
  });

  it("counts the fills the order watch saw in the last day", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    // Kept apart from the activity log, which keeps only its newest events.
    await services.store.put("order-fills:demo", ["2026-10-10T06:00:00Z", "2026-10-10T08:00:00Z", "2026-10-11T01:00:00Z"]);
    await services.store.put("order-fills:live", ["2026-10-11T03:00:00Z"]);
    expect(await services.digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[0]).toMatch(/· 2 order\(s\) filled in the last day/);
  });

  it("sends once per day at the configured hour and reports the change since the last one", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    expect(await services.digest.run(new Date("2026-10-11T06:59:00Z"))).toEqual([]);
    expect(await services.digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(await services.digest.run(new Date("2026-10-11T08:00:00Z"))).toEqual([]);
    services.total.value = 2050;
    expect(await services.digest.run(new Date("2026-10-12T07:01:00Z"))).toEqual(["demo"]);
    expect(services.hooks).toHaveLength(2);
    expect(services.hooks[0]).toMatch(/^\[TradePilot DEMO\] Daily digest · Total 2000 EUR · cash 1000 · unrealized \+100 · top: VUSA_EQ 1000 \(\+100\)/);
    expect(services.hooks[1]).toMatch(/\+50 since the last digest/);
  });

  it("retries a failed digest every 15 minutes for the rest of the day", async () => {
    // The store expires keys against the clock, so the clock moves with the scheduler here.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7" });
      const runAt = (time: string) => { vi.setSystemTime(new Date(`2026-10-11T${time}:00Z`)); return services.digest.run(new Date()); };
      services.outage.on = true;
      expect(await runAt("07:00")).toEqual([]);
      services.outage.on = false;
      expect(await runAt("07:05")).toEqual([]);
      expect(await runAt("07:16")).toEqual(["demo"]);
      expect(await runAt("07:40")).toEqual([]);
      expect(services.hooks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a day as sent only once the webhook accepts it, whatever NOTIFY_EVENTS lists", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7", NOTIFY_EVENTS: "order_submitted" });
      const runAt = (time: string) => { vi.setSystemTime(new Date(`2026-10-11T${time}:00Z`)); return services.digest.run(new Date()); };
      services.hookDown.on = true;
      expect(await runAt("07:00")).toEqual([]);
      services.hookDown.on = false;
      expect(await runAt("07:16")).toEqual(["demo"]);
      expect(services.hooks).toHaveLength(1);
      expect((await services.trading.getActivity("demo")).filter((event) => event.type === "daily_digest")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is off without an hour or a webhook", async () => {
    expect(await setup({}).digest.run(new Date("2026-10-11T12:00:00Z"))).toEqual([]);
    expect(() => createConfig({ DIGEST_HOUR_UTC: "25" })).toThrow(/DIGEST_HOUR_UTC/);
  });
});
