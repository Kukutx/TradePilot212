import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import { Goals } from "./goals.js";
import { MemoryStateStore } from "./state-store.js";

const now = new Date("2026-10-31T12:00:00Z");
const setup = () => new Goals({ config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" }), store: new MemoryStateStore() });

describe("goals", () => {
  it("saves one goal per account with the assumptions it is given or the defaults, keeping what a change leaves out", async () => {
    const goals = setup();
    const saved = await goals.set({ environment: "demo", target: 100_000, by: "2036-10-31", monthly: 300, name: " House ", currency: "EUR" }, now);
    expect(saved).toEqual({ environment: "demo", target: 100_000, by: "2036-10-31", monthly: 300, expectedReturn: 0.06, volatility: 0.15, currency: "EUR", name: "House", createdAt: now.toISOString(), updatedAt: now.toISOString() });
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
    await expect(goals.set({ ...base, environment: "live" }, now)).rejects.toThrow();
  });
});
