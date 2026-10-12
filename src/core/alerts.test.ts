import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import type { PriceAlert } from "../shared/automation.js";
import { createServices } from "../app/services.js";
import { evaluateAlert, PriceAlerts } from "./alerts.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { notificationText } from "./notify.js";
import { describePayload } from "./text-summary.js";
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
  return { ...createServices({ config, store, fetcher }), config, store, price, webhooks };
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

  it("measures a day's move either way from the previous close", () => {
    const dayMove = alert({ condition: "day_move", percent: 5 });
    const close = { day: "2026-10-12", close: 100, date: "2026-10-09", change: 0 };
    const at = (currentPrice: number) => evaluateAlert(dayMove, { currentPrice, averagePricePaid: 0 }, close);
    expect(at(105)).toMatchObject({ fired: true, message: "VUSA_EQ is at 105, +5.00% since the close on 2026-10-09 (100; alert at 5% either way)." });
    expect(at(95).fired).toBe(true);
    expect(at(104.9).fired).toBe(false);
    expect(at(95.1).fired).toBe(false);
    expect(evaluateAlert(dayMove, { currentPrice: 200, averagePricePaid: 0 })).toMatchObject({ fired: false, message: "VUSA_EQ has no previous close." });
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

  it("checks account alerts on the same tick, shows them on the automation page and sends them to the webhook", async () => {
    const services = setup({ NOTIFY_WEBHOOK_URL: "https://hooks.example/t" });
    await services.accountAlerts.create({ environment: "demo", condition: "cash_above", amount: 900, note: "Invest it." });
    expect((await services.runScheduled()).accountAlerts).toMatchObject([{ action: "triggered", message: "Free cash is 1000.00 EUR, at or above 900.00 EUR." }]);
    expect(services.webhooks[0]!.body.text).toBe("[TradePilot DEMO] Account alert · Free cash is 1000.00 EUR, at or above 900.00 EUR. Invest it.");
    const overview = await services.automationOverview("demo");
    expect(overview).toMatchObject({ currency: "EUR", account: { value: 2000, cash: 1000 }, accountAlerts: [{ condition: "cash_above", amount: 900, currency: "EUR", triggeredValue: 1000 }] });
    expect(describePayload(overview as unknown as Record<string, unknown>)).toContain("Account alerts (1):\n- free cash at or above 900 EUR (");
  });

  it("fires a day's move once a trading day and arms it again on the next", async () => {
    const services = setup();
    const day = { value: "2026-10-12", close: 100 };
    const reads: Array<{ ticker: string; price: number; quoted: boolean }> = [];
    const alerts = new PriceAlerts({
      config: services.config, store: services.store, trading: services.trading,
      dayClose: async (_environment, instrument, price, quoted) => {
        reads.push({ ticker: instrument.ticker, price, quoted });
        return { day: day.value, close: day.close, date: "2026-10-09", change: price / day.close - 1 };
      },
      tradingDay: async () => day.value,
    });
    const saved = await alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move", percent: 5, note: "check the news" });
    const stored = async () => (await alerts.list())[0]!;

    expect((await alerts.check())[0]).toMatchObject({ action: "waiting", message: expect.stringMatching(/\+0\.00% since the close on 2026-10-09/) });
    expect(await stored()).toMatchObject({ lastDayChange: 0, lastCloseDate: "2026-10-09", lastPrice: 100 });
    expect(reads).toEqual([{ ticker: "VUSA_EQ", price: 100, quoted: false }]);

    services.price.value = 106;
    expect((await alerts.check())[0]).toMatchObject({ action: "triggered" });
    expect(await stored()).toMatchObject({ triggeredPrice: 106, triggeredDay: "2026-10-12", lastDayChange: 0.06 });
    const events = await services.trading.getActivity("demo");
    expect(events.find((event) => event.type === "price_alert_triggered")?.outcome).toMatch(/\+6\.00% since the close.*check the news/);

    // The same trading day: no report, and neither a positions read nor a price read, however far it moves.
    const positionReads = { count: 0 };
    const positions = services.trading.positions.bind(services.trading);
    services.trading.positions = async (environment) => { positionReads.count += 1; return positions(environment); };
    services.price.value = 80;
    expect(await alerts.check()).toEqual([]);
    expect(reads).toHaveLength(2);
    expect(positionReads.count).toBe(0);

    // The next trading day: armed again, and it fires again on that day's move.
    day.value = "2026-10-13";
    day.close = 106;
    services.price.value = 90;
    expect((await alerts.check())[0]).toMatchObject({ action: "triggered" });
    expect(await stored()).toMatchObject({ triggeredPrice: 90, triggeredDay: "2026-10-13" });

    // A quiet day after it: armed, with the fire cleared and the day it last fired for kept.
    day.value = "2026-10-14";
    day.close = 90;
    services.price.value = 91;
    expect((await alerts.check())[0]).toMatchObject({ action: "waiting" });
    const quiet = await stored();
    expect(quiet.triggeredAt).toBeUndefined();
    expect(quiet.triggeredDay).toBe("2026-10-13");
    expect(quiet).toMatchObject({ lastPrice: 91, note: "check the news", id: saved.id });
  });

  it("never fires twice for one trading day, even when a read takes the day to be another one for a while", async () => {
    const services = setup();
    const day = { value: "2026-10-12", close: 100 };
    const alerts = new PriceAlerts({
      config: services.config, store: services.store, trading: services.trading,
      dayClose: async (_environment, _instrument, price) => ({ day: day.value, close: day.close, date: "2026-10-09", change: price / day.close - 1 }),
      tradingDay: async () => day.value,
    });
    const saved = await alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move", percent: 5 });
    services.price.value = 106;
    expect((await alerts.check())[0]).toMatchObject({ action: "triggered" });
    // A read that takes the day to be the next one, at no move from its close: armed again, without firing.
    day.value = "2026-10-13";
    day.close = 106;
    expect((await alerts.check())[0]).toMatchObject({ action: "waiting" });
    expect((await alerts.list())[0]).toMatchObject({ triggeredDay: "2026-10-12" });
    // Back on Monday against Monday's previous close: it fired for Monday already.
    day.value = "2026-10-12";
    day.close = 100;
    expect(await alerts.check()).toEqual([expect.objectContaining({ action: "waiting", message: "VUSA_EQ fired for 2026-10-12 already; it counts from the next trading day." })]);
    // Re-armed by hand on the day it fired: it still counts from the next one.
    services.price.value = 120;
    await alerts.check();
    const rearmed = await alerts.rearm(saved.id);
    expect(rearmed).toMatchObject({ triggeredDay: "2026-10-12" });
    expect(rearmed.triggeredAt).toBeUndefined();
    expect((await alerts.check())[0]).toMatchObject({ action: "waiting" });
    day.value = "2026-10-13";
    day.close = 106;
    expect((await alerts.check())[0]).toMatchObject({ action: "triggered" });
    expect((await services.trading.getActivity("demo")).filter((event) => event.type === "price_alert_triggered")).toHaveLength(2);
  });

  it("leaves a session that closed before the alert was set to the next one", async () => {
    const services = setup();
    const ended = Date.parse("2026-10-09T20:00:00Z");
    const day = { value: "2026-10-09" };
    const alerts = new PriceAlerts({
      config: services.config, store: services.store, trading: services.trading,
      dayClose: async (_environment, _instrument, price) => ({ day: day.value, close: 90, date: "2026-10-08", change: price / 90 - 1, ...(day.value === "2026-10-09" ? { ended } : {}) }),
    });
    await alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move", percent: 5 }, new Date("2026-10-10T09:00:00Z"));
    expect((await alerts.check(new Date("2026-10-10T09:05:00Z")))[0]).toMatchObject({ action: "waiting", message: "VUSA_EQ's 2026-10-09 session closed before the alert was set; it counts from the next one." });
    // Its move is still shown on the alert.
    expect((await alerts.list())[0]).toMatchObject({ lastDayChange: 0.111111, lastCloseDate: "2026-10-08", lastPrice: 100 });
    expect((await alerts.list())[0]!.triggeredAt).toBeUndefined();
    // Monday's session is on: the same move fires.
    day.value = "2026-10-12";
    expect((await alerts.check(new Date("2026-10-12T14:00:00Z")))[0]).toMatchObject({ action: "triggered" });
  });

  it("waits when a day's move has no previous close", async () => {
    const services = setup();
    const alerts = new PriceAlerts({ config: services.config, store: services.store, trading: services.trading });
    await alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move", percent: 3 });
    expect((await alerts.check())[0]).toMatchObject({ action: "waiting", message: "No quote provider is configured." });
    const missing = new PriceAlerts({
      config: services.config, store: services.store, trading: services.trading,
      dayClose: async () => ({ missing: "lag", problem: "Closes end on 2026-10-08." }),
    });
    expect((await missing.check())[0]).toMatchObject({ action: "waiting", message: "Closes end on 2026-10-08." });
    expect((await alerts.list())[0]!.lastCheckedAt).toBeUndefined();
  });

  it("validates alert inputs", async () => {
    const services = setup();
    await expect(services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move", percent: 100 })).rejects.toThrow(/below 100/);
    await expect(services.alerts.create({ environment: "demo", instrument: "VUSA", condition: "day_move" })).rejects.toThrow(/above 0/);
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
