import { describe, expect, it } from "vitest";
import type { AccountAlert } from "../shared/automation.js";
import type { AccountSummary, ActivityEvent } from "../shared/contracts.js";
import type { PortfolioToday } from "../shared/today.js";
import { AccountAlerts, accountDayMove, DAY_MOVE_EVERY_MS, evaluateAccountAlert } from "./account-alerts.js";
import { createConfig } from "./config.js";
import { notificationText } from "./notify.js";
import { MemoryStateStore } from "./state-store.js";

const alert = (patch: Partial<AccountAlert>): AccountAlert => ({ id: "a", environment: "demo", condition: "value_above", createdAt: "2026-10-01T00:00:00Z", ...patch });
/**
 * AAPL's move on `day`, VUSA's still from Friday's session (on another exchange) and MSFT's not read: the account's
 * move is AAPL's alone, against the holdings' 10,000 before it.
 */
const today = (profitLoss: number | undefined, day = "2026-10-12", patch: Partial<PortfolioToday> = {}): PortfolioToday => ({
  kind: "portfolio_today", environment: "demo", accountCurrency: "GBP",
  moves: [
    { ticker: "AAPL_US_EQ", quantity: 1, day, ...(profitLoss === undefined ? {} : { profitLoss, base: 4_000, value: 4_000 + profitLoss }) },
    { ticker: "VUSAl_EQ", quantity: 1, day: "2026-10-09", profitLoss: -100, base: 3_000, value: 2_900 },
    { ticker: "MSFT_US_EQ", quantity: 1, day },
  ],
  invested: 10_000 + (profitLoss ?? 0),
  timestamp: "2026-10-12T15:00:00Z",
  ...patch,
});

function setup(account: AccountSummary = { currency: "GBP", totalValue: 10_000, cash: { availableToTrade: 800 } }) {
  const store = new MemoryStateStore();
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" });
  const events: ActivityEvent[] = [];
  const reads = { summary: 0, today: 0 };
  const state = { account, today: today(-310) as PortfolioToday | Error };
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

  it("takes the account's move on the latest day of its holdings, against the holdings' value before it", () => {
    expect(accountDayMove(today(-310))).toEqual({ change: -0.031, profitLoss: -310, day: "2026-10-12", counted: 1, of: 3 });
    // Without AAPL's move, Friday's is the latest.
    expect(accountDayMove(today(undefined))).toMatchObject({ day: "2026-10-09", profitLoss: -100, change: -100 / 10_100, counted: 1 });
    // Every holding read on the same day: against their base, as get_portfolio_today's total.
    const whole: PortfolioToday = { ...today(-310), moves: [{ ticker: "A", quantity: 1, day: "2026-10-12", profitLoss: -300, base: 6_000 }, { ticker: "B", quantity: 0, day: "2026-10-12", profitLoss: -100, base: 4_000 }], ended: { "2026-10-12": 1_000 } };
    expect(accountDayMove(whole)).toEqual({ change: -0.04, profitLoss: -400, day: "2026-10-12", counted: 2, of: 2, closed: 1_000 });
    // Some holdings not read and no value from Trading 212: it is not put against the account.
    const { invested: _, ...unknown } = today(-310);
    expect(accountDayMove(unknown)).toEqual({ problem: "Trading 212 did not report the holdings' value, so the day's move of 1 of 3 holdings cannot be put against the account." });
    expect(accountDayMove({ ...today(-310), moves: [] })).toEqual({ problem: "No holding has a move for the day yet." });
    expect(accountDayMove({ ...today(-310), invested: 0, moves: [{ ticker: "A", quantity: 0, day: "2026-10-12", profitLoss: 5, value: 0 }, { ticker: "B", quantity: 1, day: "2026-10-12" }] })).toEqual({ problem: "The holdings have no value to measure the day's move against." });
  });

  it("measures a day with sales against what was held before them, not the value left", () => {
    // 100 X held at a close of 100, 90 sold at 101, now at 101; Y, on another exchange, still on the day before.
    const sold: PortfolioToday = { ...today(0), invested: 11_010, moves: [
      { ticker: "X", quantity: 10, day: "2026-10-12", profitLoss: 100, base: 10_000, value: 1_010, sold: 90 },
      { ticker: "Y", quantity: 1, day: "2026-10-09", profitLoss: 0, base: 10_000, value: 10_000 },
    ] };
    expect(accountDayMove(sold)).toMatchObject({ change: 100 / 20_000, counted: 1, of: 2 });
    // S sold out at a loss of 200 on its 10,000; Z, the same day, without a move yet, worth 5,000.
    const out: PortfolioToday = { ...today(0), invested: 5_000, moves: [
      { ticker: "S", quantity: 0, day: "2026-10-12", profitLoss: -200, base: 10_000, value: 0, sold: 50 },
      { ticker: "Z", quantity: 10, day: "2026-10-12", missing: "later" },
    ] };
    expect(accountDayMove(out)).toMatchObject({ change: -200 / 15_000, counted: 1, of: 2 });
  });

  it("does not take a day guessed for want of the exchange schedules", () => {
    const guessed = (move: PortfolioToday["moves"][number]) => ({ ...move, guessed: true as const });
    const base = today(-310);
    expect(accountDayMove({ ...base, moves: base.moves.map(guessed) })).toEqual({ problem: "Trading 212's exchange schedules could not be read, so the trading day of the holdings' moves is not known." });
    // A known Friday and a guessed Monday: Friday's, with Monday's mover taken as flat.
    expect(accountDayMove({ ...base, moves: [guessed(base.moves[0]!), base.moves[1]!, base.moves[2]!] })).toMatchObject({ day: "2026-10-09", profitLoss: -100 });
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
    expect(await at("2026-10-12T15:00:00Z")).toMatchObject([{ action: "triggered", message: "The account is -3.10% on 2026-10-12 (-310.00 GBP across 1 of 3 holdings; alert at 3% either way)." }]);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("value");
    // Within ten minutes it reads nothing; after them, it has fired for the day already.
    expect(await at("2026-10-12T15:05:00Z")).toEqual([]);
    expect(reads.today).toBe(1);
    state.today = today(-500);
    expect(await at("2026-10-12T15:10:00Z")).toMatchObject([{ action: "waiting" }]);
    expect(reads.today).toBe(2);
    expect(events).toHaveLength(1);
    expect((await alerts.list())[0]).toMatchObject({ id: move.id, triggeredDay: "2026-10-12", triggeredValue: -0.031, lastValue: -0.05, lastDay: "2026-10-12" });
    // The next trading day arms it again.
    state.today = today(350, "2026-10-13");
    expect(await at("2026-10-13T15:00:00Z")).toMatchObject([{ action: "triggered" }]);
    expect((await alerts.list())[0]).toMatchObject({ triggeredDay: "2026-10-13", triggeredValue: 0.035 });
    // A smaller move the day after leaves it armed.
    state.today = today(100, "2026-10-14");
    expect(await at("2026-10-14T15:00:00Z")).toMatchObject([{ action: "waiting" }]);
    // Armed again, it keeps when it last fired, for the daily digest.
    expect((await alerts.list())[0]).toMatchObject({ lastTriggeredAt: "2026-10-13T15:00:00.000Z" });
    expect((await alerts.list())[0]?.triggeredAt).toBeUndefined();
  });

  it("does not report a day before the one it was set on, and waits when the move cannot be read", async () => {
    const { alerts, events, reads, state } = setup();
    // Set on a Saturday: Friday's move does not count.
    await alerts.create({ environment: "demo", condition: "day_move", percent: 1 }, new Date("2026-10-10T09:00:00Z"));
    state.today = today(-400, "2026-10-09");
    expect(await alerts.check(new Date("2026-10-10T10:00:00Z"))).toMatchObject([{ action: "waiting" }]);
    expect(events).toHaveLength(0);
    // A failed read waits ten minutes too.
    state.today = new Error("Trading 212 is busy");
    expect(await alerts.check(new Date("2026-10-12T10:00:00Z"))).toMatchObject([{ action: "waiting", message: "Trading 212 is busy" }]);
    expect(await alerts.check(new Date("2026-10-12T10:01:00Z"))).toEqual([]);
    expect(reads.today).toBe(2);
    expect(DAY_MOVE_EVERY_MS).toBe(600_000);
  });

  it("does not count a holding still on the day before, so a move fires once and the next day's still fires", async () => {
    const { alerts, events, state } = setup();
    await alerts.create({ environment: "demo", condition: "day_move", percent: 3 }, new Date("2026-10-12T08:00:00Z"));
    // Monday: the US holding falls 4%.
    state.today = { ...today(-400), moves: [{ ticker: "AAPL_US_EQ", quantity: 1, day: "2026-10-12", profitLoss: -400, base: 10_000, value: 9_600 }, { ticker: "7203_JP_EQ", quantity: 1, day: "2026-10-12", profitLoss: 0, base: 1_000, value: 1_000 }] };
    expect(await alerts.check(new Date("2026-10-12T20:30:00Z"))).toMatchObject([{ action: "triggered" }]);
    // Tuesday's Tokyo session opens while the US one is still Monday's: only Tokyo's move is Tuesday's.
    state.today = { ...today(-400), invested: 10_610, moves: [{ ticker: "AAPL_US_EQ", quantity: 1, day: "2026-10-12", profitLoss: -400, base: 10_000, value: 9_600 }, { ticker: "7203_JP_EQ", quantity: 1, day: "2026-10-13", profitLoss: 10, base: 1_000, value: 1_010 }] };
    expect(await alerts.check(new Date("2026-10-13T01:00:00Z"))).toMatchObject([{ action: "waiting", message: "The account is +0.09% on 2026-10-13 (+10.00 GBP across 1 of 2 holdings; alert at 3% either way)." }]);
    // Ten minutes on, the schedules cannot be read: the day is guessed, and nothing fires on it.
    state.today = { ...today(-400), moves: [{ ticker: "AAPL_US_EQ", quantity: 1, day: "2026-10-13", guessed: true, profitLoss: -400, base: 10_000, value: 9_600 }, { ticker: "7203_JP_EQ", quantity: 1, day: "2026-10-13", guessed: true, profitLoss: 10, base: 1_000, value: 1_010 }] };
    expect(await alerts.check(new Date("2026-10-13T01:10:00Z"))).toMatchObject([{ action: "waiting", message: expect.stringContaining("schedules could not be read") }]);
    // Tuesday's US session: a 5% fall is Tuesday's to report.
    state.today = { ...today(-500), moves: [{ ticker: "AAPL_US_EQ", quantity: 1, day: "2026-10-13", profitLoss: -500, base: 9_600, value: 9_100 }, { ticker: "7203_JP_EQ", quantity: 1, day: "2026-10-13", profitLoss: 10, base: 1_000, value: 1_010 }] };
    expect(await alerts.check(new Date("2026-10-13T15:00:00Z"))).toMatchObject([{ action: "triggered" }]);
    expect(events.map((event) => event.outcome)).toEqual([
      "The account is -3.64% on 2026-10-12 (-400.00 GBP across 2 of 2 holdings; alert at 3% either way).",
      "The account is -4.62% on 2026-10-13 (-490.00 GBP across 2 of 2 holdings; alert at 3% either way).",
    ]);
  });

  it("reads the day's move once for all the day's-move alerts of an account, every ten minutes", async () => {
    const { alerts, reads, store } = setup();
    const first = await alerts.create({ environment: "demo", condition: "day_move", percent: 5 }, new Date("2026-10-12T08:00:00Z"));
    await alerts.check(new Date("2026-10-12T10:00:00Z"));
    const second = await alerts.create({ environment: "demo", condition: "day_move", percent: 8 }, new Date("2026-10-12T10:03:00Z"));
    // The new one is due: both are read and stamped together.
    expect(await alerts.check(new Date("2026-10-12T10:04:00Z"))).toHaveLength(2);
    expect(reads.today).toBe(2);
    expect(await alerts.check(new Date("2026-10-12T10:08:00Z"))).toEqual([]);
    expect(await alerts.check(new Date("2026-10-12T10:13:00Z"))).toEqual([]);
    expect(await alerts.check(new Date("2026-10-12T10:14:00Z"))).toHaveLength(2);
    expect(reads.today).toBe(3);
    for (const alert of [first, second]) expect((await store.get<AccountAlert>(`account-alert:${alert.id}`))?.lastCheckedAt).toBe("2026-10-12T10:14:00.000Z");
  });

  it("takes when the session closed for whether it was before the alert", async () => {
    const { alerts, events, state } = setup();
    const closed = Date.parse("2026-10-12T20:00:00Z");
    state.today = today(-400, "2026-10-12", { ended: { "2026-10-12": closed } });
    // Set the same evening (UTC), after the close: Monday's fall is not its to report.
    await alerts.create({ environment: "demo", condition: "day_move", percent: 3 }, new Date("2026-10-12T21:00:00Z"));
    expect(await alerts.check(new Date("2026-10-12T21:05:00Z"))).toMatchObject([{ action: "waiting", message: expect.stringContaining("That session was over before the alert was set") }]);
    // One set before the close does report it.
    const { alerts: earlier, state: same } = setup();
    same.today = state.today;
    await earlier.create({ environment: "demo", condition: "day_move", percent: 3 }, new Date("2026-10-12T19:00:00Z"));
    expect(await earlier.check(new Date("2026-10-12T21:05:00Z"))).toMatchObject([{ action: "triggered" }]);
    expect(events).toHaveLength(0);
  });

  it("checks what it is given", async () => {
    const { alerts } = setup();
    await expect(alerts.create({ environment: "demo", condition: "value_above" })).rejects.toThrow("needs a positive amount");
    await expect(alerts.create({ environment: "demo", condition: "day_move", percent: 100 })).rejects.toThrow("below 100");
    await expect(alerts.create({ environment: "live", condition: "cash_below", amount: 10 })).rejects.toThrow();
    await expect(alerts.delete("missing")).rejects.toThrow("Account alert not found");
  });
});
