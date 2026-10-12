import { describe, expect, it } from "vitest";
import type { TargetAllocation } from "../shared/automation.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { allocationDrift, contributionSplit, driftSummary } from "./targets.js";

const saved = (patch: Partial<TargetAllocation> = {}): TargetAllocation => ({
  environment: "demo",
  targets: [{ ticker: "AAPL_US_EQ", weight: 0.5 }, { ticker: "VUSAl_EQ", weight: 0.4 }],
  cashWeight: 0.1,
  driftThreshold: 0.05,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

function sample() {
  const webhooks: Array<Record<string, unknown>> = [];
  const passthrough = (async (input: URL | RequestInfo, init?: RequestInit) => {
    webhooks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("ok");
  }) as typeof fetch;
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", NOTIFY_WEBHOOK_URL: "https://hooks.example/t" });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher: passthrough }), store, webhooks };
}

describe("allocation drift", () => {
  it("compares each target and cash with today's weights, largest drift first", () => {
    const drift = allocationDrift(saved(), {
      cashWeight: 0.02,
      holdings: [
        { ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 620, weight: 0.62 },
        { ticker: "VUSAl_EQ", name: "S&P 500", currency: "GBX", value: 330, weight: 0.33 },
        { ticker: "KO_US_EQ", name: "Coca-Cola", currency: "USD", value: 30, weight: 0.03 },
      ],
    });
    expect(drift.rows).toEqual([
      { ticker: "AAPL_US_EQ", target: 0.5, current: 0.62, drift: 0.12, currency: "USD" },
      { ticker: "VUSAl_EQ", target: 0.4, current: 0.33, drift: -0.07, currency: "GBX" },
    ]);
    // Without the account's value there is no estimate of the trades.
    expect(drift.rebalance).toBeUndefined();
    expect(drift.cash).toEqual({ target: 0.1, current: 0.02, drift: -0.08 });
    expect(drift.untargeted).toEqual([{ ticker: "KO_US_EQ", current: 0.03 }]);
    expect(drift.maxDrift).toBe(0.12);
    expect(drift.over).toBe(true);
    expect(driftSummary(drift)).toBe("AAPL_US_EQ is 62.0% against a 50.0% target (+12.0 points); notices start above 5.0 points.");
  });

  it("counts holdings without a target only when the targets sell them", () => {
    const holdings = [
      { ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 1, weight: 0.45 },
      { ticker: "VUSAl_EQ", name: "S&P 500", currency: "GBX", value: 1, weight: 0.33 },
      { ticker: "KO_US_EQ", name: "Coca-Cola", currency: "USD", value: 1, weight: 0.2 },
    ];
    // Kept: the largest drift is cash, 8 points under its target.
    expect(allocationDrift(saved(), { cashWeight: 0.02, holdings })).toMatchObject({ maxDrift: 0.08, over: true });
    // Sold: Coca-Cola's 20% is all drift.
    expect(allocationDrift(saved({ sellUntargeted: true, driftThreshold: 0.1 }), { cashWeight: 0.02, holdings })).toMatchObject({ sellUntargeted: true, maxDrift: 0.2, over: true });
    expect(allocationDrift(saved({ driftThreshold: 0.1 }), { cashWeight: 0.02, holdings }).over).toBe(false);
  });

  it("estimates what a rebalance all the way to the targets trades, and the fee on the part in other currencies", () => {
    // A GBP account of 10,000: Apple in dollars, the S&P 500 fund in pence, Coca-Cola without a target.
    const holdings = [
      { ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 6200, weight: 0.62 },
      { ticker: "VUSAl_EQ", name: "S&P 500", currency: "GBX", value: 3300, weight: 0.33 },
      { ticker: "KO_US_EQ", name: "Coca-Cola", currency: "USD", value: 300, weight: 0.03 },
    ];
    const analysis = { cashWeight: 0.02, holdings, totalValue: 10_000, accountCurrency: "GBP" };
    // Sell 1200 of Apple (dollars), buy 700 of the fund (pence are pounds); Coca-Cola is kept.
    expect(allocationDrift(saved(), analysis).rebalance).toEqual({ currency: "GBP", bought: 700, sold: 1200, converted: 1200, fxFee: 1.8, fxFeeRate: 0.0015 });
    // Sold with the targets, Coca-Cola's 300 adds to the sells, in dollars too.
    expect(allocationDrift(saved({ sellUntargeted: true }), analysis, { fxFeeRate: 0.001 }).rebalance).toEqual({ currency: "GBP", bought: 700, sold: 1500, converted: 1500, fxFee: 1.5, fxFeeRate: 0.001 });
    // A target not held takes its currency from the instrument list; without one it counts as converted.
    const away = saved({ targets: [{ ticker: "AAPL_US_EQ", weight: 0.5 }, { ticker: "VUSAl_EQ", weight: 0.33 }, { ticker: "SAPd_EQ", weight: 0.1 }] });
    const listed = allocationDrift(away, analysis, { currencyOf: (ticker) => (ticker === "SAPd_EQ" ? "EUR" : undefined) });
    expect(listed.rows.find((row) => row.ticker === "SAPd_EQ")).toMatchObject({ currency: "EUR", current: 0, target: 0.1 });
    expect(listed.rebalance).toEqual({ currency: "GBP", bought: 1000, sold: 1200, converted: 2200, fxFee: 3.3, fxFeeRate: 0.0015 });
    expect(allocationDrift(away, analysis).rebalance).toMatchObject({ converted: 2200, unknownCurrency: 1 });
  });

  it("counts a target that is not held as fully under weight", () => {
    const drift = allocationDrift(saved({ driftThreshold: 0.5 }), { cashWeight: 0.1, holdings: [{ ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 1, weight: 0.9 }] });
    expect(drift.rows.find((row) => row.ticker === "VUSAl_EQ")).toEqual({ ticker: "VUSAl_EQ", target: 0.4, current: 0, drift: -0.4 });
    expect(drift.over).toBe(false);
  });
});

describe("contribution split", () => {
  const weights = [{ ticker: "A", weight: 0.6 }, { ticker: "B", weight: 0.3 }, { ticker: "C", weight: 0.1 }];
  it("closes the largest gaps first and never needs a sale", () => {
    // After 100 more, 1000 is wanted as 600 / 300 / 100; A is over its goal and gets nothing.
    expect(contributionSplit(weights, new Map([["A", 700], ["B", 150], ["C", 50]]), 100)).toEqual([{ ticker: "B", amount: 75 }, { ticker: "C", amount: 25 }]);
  });

  it("follows the weights when every target is on goal, and covers a target not held yet", () => {
    expect(contributionSplit(weights, new Map([["A", 540], ["B", 270], ["C", 90]]), 100)).toEqual([{ ticker: "A", amount: 60 }, { ticker: "B", amount: 30 }, { ticker: "C", amount: 10 }]);
    expect(contributionSplit([{ ticker: "A", weight: 0.5 }, { ticker: "B", weight: 0.5 }], new Map([["A", 100]]), 50)).toEqual([{ ticker: "B", amount: 50 }]);
    expect(contributionSplit(weights, new Map(), 0)).toEqual([]);
  });
});

describe("saved targets", () => {
  it("resolves instruments, leaves the rest to cash and rejects impossible targets", async () => {
    const services = sample();
    const result = await services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.3 }, { instrument: "VUSAl_EQ", weight: 0.5 }] }, new Date("2026-10-01T00:00:00Z"));
    expect(result.targets).toEqual([{ ticker: "AAPL_US_EQ", weight: 0.3 }, { ticker: "VUSAl_EQ", weight: 0.5 }]);
    expect(result.cashWeight).toBe(0.2);
    expect(result.driftThreshold).toBe(0.05);
    await expect(services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.3 }, { instrument: "AAPL_US_EQ", weight: 0.2 }] })).rejects.toThrow(/named more than once/);
    await expect(services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.8 }], cashWeight: 0.3 })).rejects.toThrow(/more than 100%/);
    await expect(services.targets.set("live", { targets: [{ instrument: "AAPL", weight: 0.8 }] })).rejects.toThrow(/LIVE credentials/);
    // Rounded to 0.5001 and 0.5 when stored, which the rebalance planner would refuse.
    await expect(services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.50005 }, { instrument: "KO_US_EQ", weight: 0.5 }] })).rejects.toThrow(/more than 100%/);
    await expect(services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.00001 }] })).rejects.toThrow(/at least 0.0001/);
    const thirds = await services.targets.set("demo", { targets: ["AAPL", "KO_US_EQ", "MSFT_US_EQ"].map((instrument) => ({ instrument, weight: 1 / 3 })) });
    expect(thirds.cashWeight).toBe(0.0001);
    await expect(services.trading.planRebalance("demo", thirds.targets, { cashWeight: thirds.cashWeight })).resolves.toBeDefined();
    expect(await services.targets.clear("demo")).toBe(true);
    expect(await services.targets.get("demo")).toBeUndefined();
  });

  it("adds the drift and a flag to the allocation analysis", async () => {
    const services = sample();
    await services.targets.set("demo", { targets: [{ instrument: "KO_US_EQ", weight: 0.9 }], cashWeight: 0.1 });
    const analysis = await services.targets.withDrift(await services.insights.allocation("demo"));
    expect(analysis.drift?.rows[0]?.ticker).toBe("KO_US_EQ");
    expect(analysis.drift?.over).toBe(true);
    expect(analysis.flags.map((flag) => flag.code)).toContain("DRIFT_OVER_THRESHOLD");
    expect(analysis.drift?.untargeted.map((item) => item.ticker)).toContain("AAPL_US_EQ");
  });

  it("prices a rebalance to the targets, with the currency of a target not held from the instrument list", async () => {
    const services = sample();
    const read = await services.insights.allocation("demo");
    // A euro listing the sample account does not hold.
    const away = ["ASMLa_EQ", "EUNLd_EQ"].find((ticker) => !read.holdings.some((holding) => holding.ticker === ticker))!;
    await services.targets.set("demo", { targets: [{ instrument: "KO_US_EQ", weight: 0.5 }, { instrument: away, weight: 0.2 }], cashWeight: 0.1 });
    const { drift } = await services.targets.withDrift(read);
    expect(drift?.rows.find((row) => row.ticker === away)).toMatchObject({ currency: "EUR", current: 0 });
    expect(drift?.rows.find((row) => row.ticker === "KO_US_EQ")?.currency).toBe("USD");
    // The euro buy converts nothing in a euro account; the dollar trades do.
    const rebalance = drift!.rebalance!;
    expect(rebalance).toMatchObject({ currency: "EUR", fxFeeRate: 0.0015 });
    const ko = read.holdings.find((holding) => holding.ticker === "KO_US_EQ")!.weight;
    expect(rebalance.converted).toBeCloseTo(Math.abs(0.5 - ko) * read.totalValue, 0);
    expect(rebalance.bought + rebalance.sold).toBeGreaterThan(rebalance.converted);
    expect(rebalance.unknownCurrency).toBeUndefined();
    expect(rebalance.fxFee).toBeCloseTo(rebalance.converted * 0.0015, 2);
  });

  it("checks about once an hour and notifies at most once a day while the drift lasts", async () => {
    const services = sample();
    const start = new Date();
    await services.targets.set("demo", { targets: [{ instrument: "KO_US_EQ", weight: 0.9 }], cashWeight: 0.1 }, start);
    const first = await services.targets.check(start);
    expect(first).toEqual([expect.objectContaining({ environment: "demo", notified: true })]);
    expect(await services.targets.check(new Date(start.getTime() + 60_000))).toEqual([]);
    expect(await services.targets.check(new Date(start.getTime() + 2 * 3_600_000))).toEqual([expect.objectContaining({ notified: false })]);
    expect(await services.targets.check(new Date(start.getTime() + 25 * 3_600_000))).toEqual([expect.objectContaining({ notified: true })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = services.webhooks.map((hook) => hook.event as { type: string; outcome?: string });
    expect(events.filter((event) => event.type === "allocation_drift")).toHaveLength(2);
    expect(String(services.webhooks[0]!.text)).toMatch(/Allocation has drifted from your targets · KO_US_EQ is/);
  });

  it("stays quiet within the threshold and without saved targets", async () => {
    const services = sample();
    expect(await services.targets.check()).toEqual([]);
    const analysis = await services.insights.allocation("demo");
    await services.targets.set("demo", {
      targets: analysis.holdings.map((holding) => ({ instrument: holding.ticker, weight: Math.round(holding.weight * 10_000) / 10_000 })),
      cashWeight: Math.round(analysis.cashWeight * 10_000) / 10_000,
    });
    expect(await services.targets.check()).toEqual([expect.objectContaining({ notified: false })]);
    expect(services.webhooks).toHaveLength(0);
  });
});
