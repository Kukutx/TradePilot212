import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function setup(env: RuntimeEnv = {}, store = new MemoryStateStore()) {
  const account = { value: 1000 as number | undefined, reads: 0, id: 1 as number | undefined, slowMs: 0 };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/equity/account/summary")) {
      account.reads++;
      // A slow answer moves the (fake) clock on, as a retried request would.
      if (account.slowMs) vi.setSystemTime(Date.now() + account.slowMs);
      return json({ ...(account.id === undefined ? {} : { id: account.id }), currency: "EUR", ...(account.value === undefined ? {} : { totalValue: account.value }), cash: { availableToTrade: 100 }, investments: { currentValue: 900 } });
    }
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", ...env });
  return { ...createServices({ config, store, fetcher }), account, store };
}

const at = (iso: string) => new Date(iso);

describe("value history", () => {
  // The clock stands still unless a test moves it, so each recorded time is the tick's.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the last value read each day, reading about once an hour", async () => {
    const { values, account } = setup();
    expect(await values.snapshot(at("2026-10-10T08:00:00Z"))).toHaveLength(1);
    account.value = 1010;
    // Within the hour nothing is read.
    expect(await values.snapshot(at("2026-10-10T08:30:00Z"))).toEqual([]);
    expect(account.reads).toBe(1);
    await values.snapshot(at("2026-10-10T21:00:00Z"));
    account.value = 1050;
    await values.snapshot(at("2026-10-11T09:00:00Z"));
    expect(await values.points("demo")).toEqual([
      { date: "2026-10-10", totalValue: 1010, cash: 100, invested: 900, at: "2026-10-10T21:00:00.000Z" },
      { date: "2026-10-11", totalValue: 1050, cash: 100, invested: 900, at: "2026-10-11T09:00:00.000Z" },
    ]);
  });

  it("filters by date, across months, and skips a missing value", async () => {
    const { values, account, store } = setup();
    for (const day of ["2026-08-31", "2026-09-01", "2026-09-15", "2026-10-01"]) await values.record("demo", { date: day, totalValue: 1, at: `${day}T20:00:00Z` });
    expect((await values.points("demo", { from: "2026-09-01", to: "2026-09-30" })).map((point) => point.date)).toEqual(["2026-09-01", "2026-09-15"]);
    // A date-time bound compares when each value was read, as the transaction history does.
    expect((await values.points("demo", { from: "2026-09-01T21:00:00Z", to: "2026-09-15T20:00:00Z" })).map((point) => point.date)).toEqual(["2026-09-15"]);
    expect((await values.points("demo", { from: "2026-08-31T12:00:00Z", to: "2026-09-01T12:00:00Z" })).map((point) => point.date)).toEqual(["2026-08-31"]);
    // One key per month keeps each stored value small.
    expect((await store.list("value-history:demo:")).map((entry) => entry.key).sort()).toEqual(["value-history:demo:2026-08", "value-history:demo:2026-09", "value-history:demo:2026-10"]);
    account.value = undefined;
    expect(await values.snapshot(at("2026-10-02T09:00:00Z"))).toEqual([]);
    expect(await values.points("live")).toEqual([]);
  });

  it("dates a value by when Trading 212 answered, not when the tick began", async () => {
    const { values, account } = setup();
    vi.setSystemTime(at("2026-10-10T23:59:30Z"));
    account.slowMs = 90_000;
    expect((await values.snapshot(new Date()))[0]?.point).toMatchObject({ date: "2026-10-11", at: "2026-10-11T00:01:00.000Z" });
    expect((await values.points("demo")).map((point) => point.date)).toEqual(["2026-10-11"]);
  });

  it("keeps the sample account's days apart and shows only the current account's", async () => {
    const store = new MemoryStateStore();
    const sample = setup({ TRADEPILOT_SAMPLE_DATA: "true" }, store);
    await sample.values.record("demo", { date: "2026-10-01", totalValue: 5, at: "2026-10-01T20:00:00Z" });
    const real = setup({}, store);
    expect(await real.values.points("demo")).toEqual([]);
    await real.values.snapshot(at("2026-10-02T09:00:00Z"));
    real.account.id = 2;
    real.account.value = 2000;
    await real.values.snapshot(at("2026-10-03T09:00:00Z"));
    // Another Trading 212 account's days are left out, and account ids never leave the store.
    expect(await real.values.points("demo")).toEqual([{ date: "2026-10-03", totalValue: 2000, cash: 100, invested: 900, at: "2026-10-03T09:00:00.000Z" }]);
    expect((await sample.values.points("demo")).map((point) => point.totalValue)).toEqual([5]);
  });

  it("does nothing for an environment without keys", async () => {
    const { values, account } = setup();
    await values.snapshot(at("2026-10-10T08:00:00Z"));
    expect(account.reads).toBe(1);
    expect(await values.points("live")).toEqual([]);
  });

  it("summarizes the recorded values in the performance text", () => {
    const text = describePayload({
      kind: "performance", environment: "demo", accountCurrency: "EUR", period: { to: "2026-10-11T00:00:00Z" },
      coverage: { orders: 0, dividends: 0, transactions: 0, truncated: false }, contributions: { deposits: 0, withdrawals: 0, net: 0 },
      income: { dividends: 0, interest: 0 }, costs: { total: 0, byType: [] }, realizedProfitLoss: 0, trades: { buys: 0, sells: 0, turnover: 0 }, byTicker: [],
      valueHistory: [
        { date: "2026-10-01", totalValue: 1000, at: "2026-10-01T20:00:00Z" },
        { date: "2026-10-05", totalValue: 900, at: "2026-10-05T20:00:00Z" },
        { date: "2026-10-11", totalValue: 1100, at: "2026-10-11T20:00:00Z" },
      ],
      notes: [], timestamp: "2026-10-11T20:00:00Z",
    });
    expect(text).toContain("Account value recorded on 3 day(s): 1000 on 2026-10-01 to 1100 on 2026-10-11 (+100, +10%; includes deposits and withdrawals). Low 900 on 2026-10-05, high 1100 on 2026-10-11.");
  });
});
