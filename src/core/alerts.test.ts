import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import type { PriceAlert } from "../shared/automation.js";
import { createServices } from "../app/services.js";
import { evaluateAlert } from "./alerts.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { notificationText } from "./notify.js";
import { MemoryStateStore } from "./state-store.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };
const alert = (patch: Partial<PriceAlert>): PriceAlert => ({ id: "a", environment: "demo", ticker: "VUSA_EQ", condition: "above", createdAt: "2026-01-01T00:00:00Z", ...patch });

function setup(env: RuntimeEnv = {}) {
  const price = { value: 100 };
  const webhooks: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).host === "hooks.example") {
      webhooks.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
      return new Response("ok");
    }
    if (url.endsWith("/equity/metadata/instruments")) return json([instrument]);
    if (url.endsWith("/equity/positions")) return json([{ instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 80, currentPrice: price.value } satisfies Position]);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 2000, cash: { availableToTrade: 1000 } });
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", ...env });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher }), store, price, webhooks };
}

describe("price alert rules", () => {
  it("fires above and below thresholds", () => {
    expect(evaluateAlert(alert({ condition: "above", price: 100 }), { currentPrice: 101, averagePricePaid: 90 }).fired).toBe(true);
    expect(evaluateAlert(alert({ condition: "above", price: 100 }), { currentPrice: 99, averagePricePaid: 90 }).fired).toBe(false);
    expect(evaluateAlert(alert({ condition: "below", price: 100 }), { currentPrice: 100, averagePricePaid: 90 }).fired).toBe(true);
  });

  it("trails the highest price seen", () => {
    const trailing = alert({ condition: "trailing_drop", percent: 10, highWatermark: 120 });
    expect(evaluateAlert(trailing, { currentPrice: 125, averagePricePaid: 90 })).toMatchObject({ fired: false, highWatermark: 125 });
    expect(evaluateAlert(trailing, { currentPrice: 109, averagePricePaid: 90 })).toMatchObject({ fired: false, highWatermark: 120 });
    expect(evaluateAlert(trailing, { currentPrice: 108, averagePricePaid: 90 })).toMatchObject({ fired: true });
  });

  it("measures gains and losses against the average cost", () => {
    expect(evaluateAlert(alert({ condition: "gain_percent", percent: 20 }), { currentPrice: 120, averagePricePaid: 100 }).fired).toBe(true);
    expect(evaluateAlert(alert({ condition: "loss_percent", percent: 10 }), { currentPrice: 91, averagePricePaid: 100 }).fired).toBe(false);
    expect(evaluateAlert(alert({ condition: "loss_percent", percent: 10 }), { currentPrice: 90, averagePricePaid: 100 }).fired).toBe(true);
  });
});

describe("price alert scheduler", () => {
  it("keeps checking other alerts and stages when one lookup fails", async () => {
    const services = setup();
    await services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "above", price: 90 });
    const failing = await services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "above", price: 500 });
    // An alert on an instrument that is not held needs the instrument list, which now fails.
    await services.store.put(`alert:${failing.id}`, { ...failing, ticker: "GONE_EQ" });
    services.trading.instruments = async () => { throw new Error("instrument list unavailable"); };
    services.automation.runDuePlans = async () => { throw new Error("plans broke"); };
    const tick = await services.runScheduled();
    expect(tick.plans).toEqual([]);
    expect(tick.alerts.map((report) => report.action).sort()).toEqual(["triggered", "waiting"]);
  });

  it("joins a tick that is still running instead of starting another", async () => {
    const services = setup();
    let calls = 0;
    services.links.reconcile = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return []; };
    await Promise.all([services.runScheduled(), services.runScheduled()]);
    expect(calls).toBe(1);
    await services.runScheduled();
    expect(calls).toBe(2);
  });

  it("triggers once, notifies the webhook with a signature, and can be re-armed", async () => {
    const services = setup({ NOTIFY_WEBHOOK_URL: "https://hooks.example/t", NOTIFY_WEBHOOK_SECRET: "shh" });
    const saved = await services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "trailing_drop", percent: 5 });
    expect(saved.ticker).toBe("VUSA_EQ");

    services.price.value = 110;
    expect((await services.runScheduled()).alerts[0]?.action).toBe("waiting");
    services.price.value = 104;
    expect((await services.runScheduled()).alerts[0]?.action).toBe("triggered");
    expect((await services.runScheduled()).alerts).toEqual([]);

    expect(services.webhooks).toHaveLength(1);
    expect(services.webhooks[0]!.body.text).toMatch(/Price alert · VUSA_EQ · @ 104/);
    expect(services.webhooks[0]!.headers["X-TradePilot-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const [stored] = await services.alerts.list();
    expect(stored).toMatchObject({ triggeredPrice: 104, highWatermark: 110 });

    const rearmed = await services.alerts.rearm(saved.id);
    expect(rearmed.triggeredAt).toBeUndefined();
    expect(rearmed.highWatermark).toBeUndefined();
  });

  it("validates alert inputs", async () => {
    const services = setup();
    await expect(services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "above" })).rejects.toThrow(/positive price/);
    await expect(services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "trailing_drop", percent: 150 })).rejects.toThrow(/below 100/);
    await expect(services.alerts.delete("missing")).rejects.toMatchObject({ code: "ALERT_NOT_FOUND" });
  });
});

describe("notifications", () => {
  it("formats a readable line", () => {
    expect(notificationText({ id: "1", timestamp: "", environment: "live", type: "order_submitted", ticker: "AAPL_US_EQ", side: "buy", quantity: 2 }))
      .toBe("[TradePilot LIVE] Order sent · AAPL_US_EQ · buy 2");
  });

  it("only sends the configured event types and rejects plain HTTP", async () => {
    expect(() => createConfig({ NOTIFY_WEBHOOK_URL: "http://hooks.example/t" })).toThrow(/HTTPS/);
    const services = setup({ NOTIFY_WEBHOOK_URL: "https://hooks.example/t", NOTIFY_EVENTS: "plan_due" });
    await services.trading.recordActivity("order_submitted", "demo", { ticker: "VUSA_EQ" });
    await services.trading.recordActivity("plan_due", "demo", { planId: "p" });
    expect(services.webhooks.map((hook) => (hook.body.event as { type: string }).type)).toEqual(["plan_due"]);
  });
});
