import { describe, expect, it } from "vitest";
import type { TargetAllocation } from "../shared/automation.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { allocationDrift, driftSummary } from "./targets.js";

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
      { ticker: "AAPL_US_EQ", target: 0.5, current: 0.62, drift: 0.12 },
      { ticker: "VUSAl_EQ", target: 0.4, current: 0.33, drift: -0.07 },
    ]);
    expect(drift.cash).toEqual({ target: 0.1, current: 0.02, drift: -0.08 });
    expect(drift.untargeted).toEqual([{ ticker: "KO_US_EQ", current: 0.03 }]);
    expect(drift.maxDrift).toBe(0.12);
    expect(drift.over).toBe(true);
    expect(driftSummary(drift)).toBe("AAPL_US_EQ is 62.0% against a 50.0% target (+12.0 points); notices start above 5.0 points.");
  });

  it("counts a target that is not held as fully under weight", () => {
    const drift = allocationDrift(saved({ driftThreshold: 0.5 }), { cashWeight: 0.1, holdings: [{ ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 1, weight: 0.9 }] });
    expect(drift.rows.find((row) => row.ticker === "VUSAl_EQ")).toEqual({ ticker: "VUSAl_EQ", target: 0.4, current: 0, drift: -0.4 });
    expect(drift.over).toBe(false);
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
