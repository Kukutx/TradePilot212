import { describe, expect, it } from "vitest";
import type { AccountAlert } from "../shared/automation.js";
import type { AccountSummary, ActivityEvent } from "../shared/contracts.js";
import type { PortfolioToday } from "../shared/today.js";
import { AccountAlerts, accountDayMove, DAY_MOVE_EVERY_MS, evaluateAccountAlert } from "./account-alerts.js";
import { createConfig } from "./config.js";
import { notificationText } from "./notify.js";
import { MemoryStateStore } from "./state-store.js";

const alert = (patch: Partial<AccountAlert>): AccountAlert => ({ id: "a", environment: "demo", condition: "value_above", createdAt: "2026-10-01T00:00:00Z", ...patch });
const today = (change: number | undefined, day = "2026-10-12"): PortfolioToday => ({
  kind: "portfolio_today", environment: "demo", accountCurrency: "GBP",
  moves: [{ ticker: "AAPL_US_EQ", quantity: 1, day, profitLoss: -300 }, { ticker: "VUSAl_EQ", quantity: 1, day: "2026-10-09", profitLoss: -100 }],
  ...(change === undefined ? {} : { total: { profitLoss: -400, change, counted: 2, of: 3 } }),
  timestamp: "2026-10-12T15:00:00Z",
});

function setup(account: AccountSummary = { currency: "GBP", totalValue: 10_000, cash: { availableToTrade: 800 } }) {
  const store = new MemoryStateStore();
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" });
  const events: ActivityEvent[] = [];
  const reads = { summary: 0, today: 0 };
  const state = { account, today: today(-0.031) as PortfolioToday | Error };
  const trading = {
    accountSummary: async () => { reads.summary++; return state.account; },
    accountCurrency: async () => state.account.currency,
    recordActivity: async (type: ActivityEvent["type"], environment: ActivityEvent["environment"], details: Partial<ActivityEvent> = {}) => {
      const event = { id: String(events.length), timestamp: "", environment, type, ...details } as ActivityEvent;
      events.push(event);
      return event;
    },
  };
  const alerts = new AccountAlerts({
    config, store, trading,
    today: async () => { reads.today++; if (state.today instanceof Error) throw state.today; return state.today; },
  });
  return { alerts, store, events, reads, state };
}

describe("account alert rules", () => {
  it("fires on the account value and the free cash, at or past the amount", () => {
    const account = { currency: "GBP", totalValue: 10_000, cash: { availableToTrade: 800 } };
    expect(evaluateAccountAlert(alert({ condition: "value_above", amount: 10_000 }), account)).toMatchObject({ fired: true, value: 10_000, message: "The account value is 10000.00 GBP, at or above 10000.00 GBP." });
    expect(evaluateAccountAlert(alert({ condition: "value_below", amount: 9_500 }), account).fired).toBe(false);
    expect(evaluateAccountAlert(alert({ condition: "cash_below", amount: 1_000 }), account)).toMatchObject({ fired: true, value: 800 });
    expect(evaluateAccountAlert(alert({ condition: "cash_above", amount: 1_000 }), account).fired).toBe(false);
    expect(evaluateAccountAlert(alert({ condition: "cash_above", amount: 1_000 }), { currency: "GBP" })).toMatchObject({ fired: false, message: "Trading 212 did not report the free cash." });
  });

  it("takes the account's day move with the latest day of the holdings counted", () => {
    expect(accountDayMove(today(-0.031))).toEqual({ change: -0.031, profitLoss: -400, day: "2026-10-12", counted: 2, of: 3 });
    expect(accountDayMove(today(undefined))).toBeUndefined();
  });
});

describe("account alerts", () => {
  it("checks the value and cash from one summary read, fires once, and stays fired until re-armed", async () => {
    const { alerts, events, reads, state } = setup();
    const value = await alerts.create({ environment: "demo", condition: "value_below", amount: 9_000, note: "Look at the stops." });
    const cash = await alerts.create({ environment: "demo", condition: "cash_below", amount: 1_000 });
    expect(value).toMatchObject({ condition: "value_below", amount: 9_000, currency: "GBP", note: "Look at the stops." });
    const first = await alerts.check(new Date("2026-10-12T10:00:00Z"));
    expect(reads.summary).toBe(1);
    expect(first.map((report) => [report.alertId, report.action])).toEqual([[value.id, "waiting"], [cash.id, "triggered"]]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "account_alert_triggered", alertId: cash.id, value: 800, valueCurrency: "GBP", outcome: "Free cash is 800.00 GBP, at or below 1000.00 GBP." });
    expect(notificationText(events[0]!)).toBe("[TradePilot DEMO] Account alert · Free cash is 800.00 GBP, at or below 1000.00 GBP.");
    // Fired: it is not checked again; the value alert fires when the value falls.
    state.account = { currency: "GBP", totalValue: 8_900, cash: { availableToTrade: 500 } };
    const second = await alerts.check(new Date("2026-10-12T10:01:00Z"));
    expect(second.map((report) => [report.alertId, report.action])).toEqual([[value.id, "triggered"]]);
    expect(events[1]?.outcome).toBe("The account value is 8900.00 GBP, at or below 9000.00 GBP. Look at the stops.");
    const stored = await alerts.list("demo");
    expect(stored.find((item) => item.id === value.id)).toMatchObject({ triggeredValue: 8_900, lastValue: 8_900 });
    expect(stored.find((item) => item.id === cash.id)).toMatchObject({ triggeredValue: 800 });
    // Re-armed, it fires again on the next tick.
    await alerts.rearm(cash.id);
    expect(await alerts.check(new Date("2026-10-12T10:02:00Z"))).toMatchObject([{ alertId: cash.id, action: "triggered" }]);
  });

  it("writes a waiting alert's last value at most every ten minutes", async () => {
    const { alerts, store, state } = setup();
    const value = await alerts.create({ environment: "demo", condition: "value_above", amount: 20_000 });
    await alerts.check(new Date("2026-10-12T10:00:00Z"));
    state.account = { currency: "GBP", totalValue: 10_100 };
    await alerts.check(new Date("2026-10-12T10:05:00Z"));
    expect((await store.get<AccountAlert>(`account-alert:${value.id}`))?.lastValue).toBe(10_000);
    await alerts.check(new Date("2026-10-12T10:10:00Z"));
    expect((await store.get<AccountAlert>(`account-alert:${value.id}`))?.lastValue).toBe(10_100);
  });

  it("fires on the account's day move once a trading day, read every ten minutes", async () => {
    const { alerts, events, reads, state } = setup();
    const move = await alerts.create({ environment: "demo", condition: "day_move", percent: 3 }, new Date("2026-10-12T08:00:00Z"));
    const at = (time: string) => alerts.check(new Date(time));
    expect(await at("2026-10-12T15:00:00Z")).toMatchObject([{ action: "triggered", message: "The account is -3.10% on 2026-10-12 (-400.00 GBP across 2 of 3 holdings; alert at 3% either way)." }]);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("value");
    // Within ten minutes it reads nothing; after them, it has fired for the day already.
    expect(await at("2026-10-12T15:05:00Z")).toEqual([]);
    expect(reads.today).toBe(1);
    state.today = today(-0.05);
    expect(await at("2026-10-12T15:10:00Z")).toMatchObject([{ action: "waiting" }]);
    expect(reads.today).toBe(2);
    expect(events).toHaveLength(1);
    expect((await alerts.list())[0]).toMatchObject({ id: move.id, triggeredDay: "2026-10-12", triggeredValue: -0.031, lastValue: -0.05, lastDay: "2026-10-12" });
    // The next trading day arms it again.
    state.today = today(0.035, "2026-10-13");
    expect(await at("2026-10-13T15:00:00Z")).toMatchObject([{ action: "triggered" }]);
    expect((await alerts.list())[0]).toMatchObject({ triggeredDay: "2026-10-13", triggeredValue: 0.035 });
    // A smaller move the day after leaves it armed.
    state.today = today(0.01, "2026-10-14");
    expect(await at("2026-10-14T15:00:00Z")).toMatchObject([{ action: "waiting" }]);
    expect((await alerts.list())[0]?.triggeredAt).toBeUndefined();
  });

  it("does not report a day before the one it was set on, and waits when the move cannot be read", async () => {
    const { alerts, events, reads, state } = setup();
    // Set on a Saturday: Friday's move does not count.
    await alerts.create({ environment: "demo", condition: "day_move", percent: 1 }, new Date("2026-10-10T09:00:00Z"));
    state.today = today(-0.04, "2026-10-09");
    expect(await alerts.check(new Date("2026-10-10T10:00:00Z"))).toMatchObject([{ action: "waiting" }]);
    expect(events).toHaveLength(0);
    // A failed read waits ten minutes too.
    state.today = new Error("Trading 212 is busy");
    expect(await alerts.check(new Date("2026-10-12T10:00:00Z"))).toMatchObject([{ action: "waiting", message: "Trading 212 is busy" }]);
    expect(await alerts.check(new Date("2026-10-12T10:01:00Z"))).toEqual([]);
    expect(reads.today).toBe(2);
    expect(DAY_MOVE_EVERY_MS).toBe(600_000);
  });

  it("checks what it is given", async () => {
    const { alerts } = setup();
    await expect(alerts.create({ environment: "demo", condition: "value_above" })).rejects.toThrow("needs a positive amount");
    await expect(alerts.create({ environment: "demo", condition: "day_move", percent: 100 })).rejects.toThrow("below 100");
    await expect(alerts.create({ environment: "live", condition: "cash_below", amount: 10 })).rejects.toThrow();
    await expect(alerts.delete("missing")).rejects.toThrow("Account alert not found");
  });
});
