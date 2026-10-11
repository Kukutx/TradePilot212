import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function setup(env: RuntimeEnv = {}) {
  const account = { value: 1000 as number | undefined, reads: 0 };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/equity/account/summary")) {
      account.reads++;
      return json({ currency: "EUR", ...(account.value === undefined ? {} : { totalValue: account.value }), cash: { availableToTrade: 100 }, investments: { currentValue: 900 } });
    }
    return json([]);
  }) as typeof fetch;
  const store = new MemoryStateStore();
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", ...env });
  return { ...createServices({ config, store, fetcher }), account, store };
}

const at = (iso: string) => new Date(iso);

describe("value history", () => {
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
    expect((await values.points("demo", { from: "2026-09-01T00:00:00Z", to: "2026-09-30" })).map((point) => point.date)).toEqual(["2026-09-01", "2026-09-15"]);
    // One key per month keeps each stored value small.
    expect((await store.list("value-history:demo:")).map((entry) => entry.key).sort()).toEqual(["value-history:demo:2026-08", "value-history:demo:2026-09", "value-history:demo:2026-10"]);
    account.value = undefined;
    expect(await values.snapshot(at("2026-10-02T09:00:00Z"))).toEqual([]);
    expect(await values.points("live")).toEqual([]);
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
