import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { digestText } from "./digest.js";
import { MemoryStateStore } from "./state-store.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };

function setup(env: Record<string, string>) {
  const hooks: string[] = [];
  const total = { value: 2000 };
  const outage = { on: false };
  const hookDown = { on: false };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).host === "hooks.example") {
      if (hookDown.on) return new Response("down", { status: 503 });
      hooks.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response("ok");
    }
    if (url.endsWith("/equity/positions")) return json([{ instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100, walletImpact: { currentValue: 1000, unrealizedProfitLoss: 100 } }]);
    if (url.endsWith("/equity/account/summary") && outage.on) return new Response(JSON.stringify({ code: "Unauthorized" }), { status: 401 });
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: total.value, cash: { availableToTrade: 1000 }, investments: { unrealizedProfitLoss: 100 } });
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", NOTIFY_WEBHOOK_URL: "https://hooks.example/t", ...env });
  return { ...createServices({ config, store: new MemoryStateStore(), fetcher }), hooks, total, outage, hookDown };
}

describe("daily digest", () => {
  it("formats a compact summary", () => {
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, previousTotalValue: 2000, cash: 10, unrealized: -5, positions: [{ ticker: "A", value: 5, profitLoss: 1 }], pendingOrders: 1, duePlans: ["Monthly"], triggeredAlerts: 0 }))
      .toBe("Total 2010 EUR (+10 since the last digest) · cash 10 · unrealized -5 · top: A 5 (+1) · 1 pending order(s) · due plans: Monthly");
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, cash: 10, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, maxDrift: 0.0712 }))
      .toBe("Total 2010 EUR · cash 10 · largest drift from targets 7.1 points");
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
