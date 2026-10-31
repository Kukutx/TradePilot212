import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import type { ActivityEvent } from "../shared/contracts.js";
import { Goals, milestoneText } from "./goals.js";
import { MemoryStateStore } from "./state-store.js";

const now = new Date("2026-10-31T12:00:00Z");
const setup = () => new Goals({ config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" }), store: new MemoryStateStore() });

describe("goals", () => {
  it("saves one goal per account with the assumptions it is given or the defaults, keeping what a change leaves out", async () => {
    const goals = setup();
    const saved = await goals.set({ environment: "demo", target: 100_000, by: "2036-10-31", monthly: 300, name: " House ", currency: "EUR" }, now);
    expect(saved).toEqual({ environment: "demo", target: 100_000, by: "2036-10-31", monthly: 300, expectedReturn: 0.06, volatility: 0.15, inflation: 0.02, currency: "EUR", name: "House", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const later = new Date("2026-11-02T00:00:00Z");
    const changed = await goals.set({ environment: "demo", target: 120_000, by: "2037-01-01", expectedReturn: 0.05 }, later);
    expect(changed).toMatchObject({ target: 120_000, monthly: 300, expectedReturn: 0.05, volatility: 0.15, name: "House", createdAt: now.toISOString(), updatedAt: later.toISOString() });
    expect(await goals.get("demo")).toEqual(changed);
    // An empty name, as the form sends when it is cleared, removes it.
    expect((await goals.set({ environment: "demo", target: 120_000, by: "2037-01-01", name: "" }, later)).name).toBeUndefined();
    expect(await goals.remove("demo")).toBe(true);
    expect(await goals.remove("demo")).toBe(false);
  });

  it("refuses what cannot be projected, and an account without keys", async () => {
    const goals = setup();
    const base = { environment: "demo" as const, target: 1_000, by: "2030-01-01" };
    await expect(goals.set({ ...base, target: 0 }, now)).rejects.toThrow("above 0");
    await expect(goals.set({ ...base, by: "2030-02-30" }, now)).rejects.toThrow("YYYY-MM-DD");
    await expect(goals.set({ ...base, by: "2026-10-01" }, now)).rejects.toThrow("future");
    await expect(goals.set({ ...base, by: "2080-01-01" }, now)).rejects.toThrow("50 years");
    await expect(goals.set({ ...base, monthly: -1 }, now)).rejects.toThrow("0 or more");
    await expect(goals.set({ ...base, expectedReturn: 6 }, now)).rejects.toThrow("as a fraction");
    await expect(goals.set({ ...base, volatility: 2 }, now)).rejects.toThrow("volatility");
    await expect(goals.set({ ...base, inflation: 0.5 }, now)).rejects.toThrow("inflation");
    await expect(goals.set({ ...base, environment: "live" }, now)).rejects.toThrow();
  });

  it("says each milestone once as the recorded value reaches it, taking the progress when the goal was set as known", async () => {
    const events: Array<Pick<ActivityEvent, "type" | "environment" | "outcome">> = [];
    const store = new MemoryStateStore();
    const goals = new Goals({
      config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", NOTIFY_LOCALE: "zh-CN" }), store,
      trading: { recordActivity: async (type, environment, details) => { events.push({ type, environment, ...(details?.outcome ? { outcome: details.outcome } : {}) }); return {} as ActivityEvent; } },
    });
    const at = (totalValue: number) => [{ environment: "demo" as const, point: { date: "2026-11-01", totalValue, at: now.toISOString() } }];
    // Nothing set: nothing measured.
    expect(await goals.check(at(1_000))).toEqual([]);
    await goals.set({ environment: "demo", target: 10_000, by: "2036-10-31", name: "House", currency: "EUR" }, now);
    expect(await goals.check(at(3_000))).toMatchObject([{ action: "seeded", milestone: 25 }]);
    expect(await goals.check(at(4_900))).toMatchObject([{ action: "none" }]);
    expect(await goals.check(at(5_200))).toMatchObject([{ action: "reached", milestone: 50 }]);
    // A fall and a rise back is not said again; a jump past two says the highest.
    expect(await goals.check(at(4_000))).toMatchObject([{ action: "none", milestone: 50 }]);
    expect(await goals.check(at(5_500))).toMatchObject([{ action: "none" }]);
    expect(await goals.check(at(10_100))).toMatchObject([{ action: "reached", milestone: 100 }]);
    expect(events).toEqual([
      { type: "goal_milestone", environment: "demo", outcome: "目标「House」已完成 50%：5,200 EUR / 10,000 EUR，截止 2036-10-31。" },
      { type: "goal_milestone", environment: "demo", outcome: "目标「House」已达成：市值 10,100 EUR，目标 10,000 EUR，截止 2036-10-31。" },
    ]);
    // The same target keeps its milestone through a change; a new one is measured afresh.
    expect((await goals.set({ environment: "demo", target: 10_000, by: "2037-10-31" }, now)).milestone).toBe(100);
    expect((await goals.set({ environment: "demo", target: 40_000, by: "2037-10-31" }, now)).milestone).toBeUndefined();
    expect(await goals.check(at(10_100))).toMatchObject([{ action: "seeded", milestone: 25 }]);
    expect(events).toHaveLength(2);
  });

  it("words a milestone in English too, naming an unnamed goal", () => {
    const goal = { environment: "demo" as const, target: 10_000, by: "2036-10-31", monthly: 0, expectedReturn: 0.06, volatility: 0.15, createdAt: "", updatedAt: "" };
    expect(milestoneText(goal, 75, 7_600, "EUR")).toBe("The investment goal is 75% of the way: 7,600 EUR of 10,000 EUR by 2036-10-31.");
  });

  it("keeps where the account stood when the target was set, for the pace, until the target changes", async () => {
    const goals = setup();
    const first = await goals.set({ environment: "demo", target: 100_000, by: "2036-10-31", value: 20_000 }, now);
    expect(first.start).toEqual({ value: 20_000, at: now.toISOString() });
    const later = new Date("2027-01-15T00:00:00Z");
    expect((await goals.set({ environment: "demo", target: 100_000, by: "2037-10-31", value: 25_000 }, later)).start).toEqual(first.start);
    expect((await goals.set({ environment: "demo", target: 90_000, by: "2037-10-31", value: 25_000 }, later)).start).toEqual({ value: 25_000, at: later.toISOString() });
    // A goal saved before inflation was asked for assumes none when it is changed.
    const store = new MemoryStateStore();
    await store.put("goal:demo", { environment: "demo", target: 1_000, by: "2030-01-01", monthly: 0, expectedReturn: 0.06, volatility: 0.15, createdAt: "", updatedAt: "" });
    const old = new Goals({ config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" }), store });
    expect((await old.set({ environment: "demo", target: 1_000, by: "2031-01-01" }, now)).inflation).toBe(0);
  });

  it("never writes the goal while it measures it, so a save or a removal made meanwhile stands", async () => {
    const store = new MemoryStateStore();
    const written: string[] = [];
    const put = store.put.bind(store);
    store.put = (async (key: string, value: unknown, expiresAt?: number) => { written.push(key); return put(key, value, expiresAt); }) as typeof store.put;
    const goals = new Goals({ config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" }), store, trading: { recordActivity: async () => ({}) as ActivityEvent } });
    const at = (totalValue: number) => [{ environment: "demo" as const, point: { date: "2026-11-01", totalValue, at: now.toISOString() } }];
    await goals.set({ environment: "demo", target: 10_000, by: "2036-10-31" }, now);
    written.length = 0;
    await goals.check(at(3_000));
    await goals.check(at(6_000));
    expect(written).toEqual(["goal-milestone:demo", "goal-milestone:demo"]);
    expect((await goals.get("demo"))?.milestone).toBe(50);
    // A removal clears the milestone with it; a goal set again starts afresh.
    await goals.remove("demo");
    await goals.set({ environment: "demo", target: 10_000, by: "2036-10-31" }, new Date(now.getTime() + 1_000));
    expect((await goals.get("demo"))?.milestone).toBeUndefined();
  });
});
