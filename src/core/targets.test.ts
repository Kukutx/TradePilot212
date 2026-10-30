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
  return { ...createServices({ config, store, fetcher: passthrough }), config, store, webhooks };
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

  it("estimates what a rebalance to the targets trades, and the fee on the part in other currencies", () => {
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

  it("estimates a rebalance of only the targets over the threshold, when that trades fewer", () => {
    const holdings = [
      { ticker: "AAPL_US_EQ", name: "Apple", currency: "USD", value: 6200, weight: 0.62 },
      { ticker: "VUSAl_EQ", name: "S&P 500", currency: "GBX", value: 3300, weight: 0.33 },
      { ticker: "KO_US_EQ", name: "Coca-Cola", currency: "USD", value: 300, weight: 0.03 },
    ];
    const analysis = { cashWeight: 0.02, holdings, totalValue: 10_000, accountCurrency: "GBP" };
    // Apple is 12 points over and the fund 7 under: over 5 points both trade, as a full rebalance does.
    expect(allocationDrift(saved(), analysis).rebalanceOver).toBeUndefined();
    // Over 10 points only Apple's sell.
    expect(allocationDrift(saved({ driftThreshold: 0.1 }), analysis).rebalanceOver).toEqual({
      tickers: ["AAPL_US_EQ"], totals: { currency: "GBP", bought: 0, sold: 1200, converted: 1200, fxFee: 1.8, fxFeeRate: 0.0015 },
    });
    // Sold with the targets, Coca-Cola's 3% is within 10 points and stays; over 15 points nothing trades.
    expect(allocationDrift(saved({ driftThreshold: 0.1, sellUntargeted: true }), analysis).rebalanceOver?.tickers).toEqual(["AAPL_US_EQ"]);
    expect(allocationDrift(saved({ driftThreshold: 0.15 }), analysis).rebalanceOver).toBeUndefined();
    // Fitted to the cash as the full estimate is: 200 free above a 0% cash target buys part of the fund only.
    const fitted = allocationDrift(saved({ driftThreshold: 0.06, cashWeight: 0, targets: [{ ticker: "AAPL_US_EQ", weight: 0.6 }, { ticker: "VUSAl_EQ", weight: 0.4 }] }), { ...analysis, cash: 200 });
    expect(fitted.rebalanceOver).toMatchObject({ tickers: ["VUSAl_EQ"], totals: { bought: 200, sold: 0, buysScaled: 0.2857 } });
  });

  it("puts the cash the sells over the threshold would leave too far over its target into the targets below theirs", () => {
    // As the planner: A's sell would leave cash 6 points over its 10% target, so B and C, within the threshold, take it.
    const holdings = [
      { ticker: "A", name: "A", currency: "EUR", value: 3700, weight: 0.37 },
      { ticker: "B", name: "B", currency: "EUR", value: 2700, weight: 0.27 },
      { ticker: "C", name: "C", currency: "EUR", value: 2700, weight: 0.27 },
    ];
    const targets = saved({ targets: [{ ticker: "A", weight: 0.3 }, { ticker: "B", weight: 0.3 }, { ticker: "C", weight: 0.3 }], cashWeight: 0.1 });
    const drift = allocationDrift(targets, { cashWeight: 0.09, cash: 900, holdings, totalValue: 10_000, accountCurrency: "EUR" });
    // Every target trades, as a full rebalance does: nothing to offer.
    expect(drift.rebalanceOver).toBeUndefined();
    // A 6 points over its 25%; B and D 4 under theirs, C 2 over: A's 600 would leave cash 6 points over its 10%, so
    // it goes to B and D. C stays, which a full rebalance would sell.
    const four = allocationDrift(saved({ targets: [{ ticker: "A", weight: 0.25 }, { ticker: "B", weight: 0.25 }, { ticker: "C", weight: 0.25 }, { ticker: "D", weight: 0.15 }], cashWeight: 0.1 }), {
      cashWeight: 0.1, cash: 1000, totalValue: 10_000, accountCurrency: "EUR",
      holdings: [["A", 3100], ["B", 2100], ["C", 2700], ["D", 1100]].map(([ticker, value]) => ({ ticker: String(ticker), name: String(ticker), currency: "EUR", value: Number(value), weight: Number(value) / 10_000 })),
    });
    expect(four.rebalanceOver).toEqual({ tickers: ["A"], cashTo: ["B", "D"], totals: { currency: "EUR", bought: 600, sold: 600, converted: 0, fxFee: 0, fxFeeRate: 0.0015 } });
  });

  it("fits the buys to the cash, as the planner does, and takes an unknown currency for none", () => {
    // 10,000 GBP: A and B, 35% each, under their 50% targets; C, 30% with no target, is kept; no cash.
    const holdings = [
      { ticker: "A", name: "A", currency: "USD", value: 3500, weight: 0.35 },
      { ticker: "B", name: "B", currency: "GBP", value: 3500, weight: 0.35 },
      { ticker: "C", name: "C", currency: "?", value: 3000, weight: 0.3 },
    ];
    const targets = saved({ targets: [{ ticker: "A", weight: 0.5 }, { ticker: "B", weight: 0.5 }], cashWeight: 0 });
    const broke = allocationDrift(targets, { cashWeight: 0, cash: 0, holdings, totalValue: 10_000, accountCurrency: "GBP" });
    // Nothing to sell and no cash: a rebalance buys nothing, and the estimate says so.
    expect(broke.rebalance).toEqual({ currency: "GBP", bought: 0, sold: 0, converted: 0, fxFee: 0, fxFeeRate: 0.0015, buysScaled: 0 });
    // 1,500 free: half the buys, the fee on the dollar half included.
    const half = allocationDrift(targets, { cashWeight: 0.13, cash: 1500, availableCash: 1500, holdings, totalValue: 11_500, accountCurrency: "GBP" });
    expect(half.rebalance!.bought + half.rebalance!.fxFee).toBeCloseTo(1500, 1);
    expect(half.rebalance!.buysScaled).toBeLessThan(0.5);
    // Sold with the targets, C's currency is not known: it counts as converted and is named as such.
    const sold = allocationDrift({ ...targets, sellUntargeted: true }, { cashWeight: 0, cash: 0, holdings, totalValue: 10_000, accountCurrency: "GBP" });
    expect(sold.rebalance).toMatchObject({ sold: 3000, unknownCurrency: 1 });
    expect(sold.rebalance!.buysScaled).toBeGreaterThan(0.99);
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

  it("keeps the day's drift notice when the same targets are saved again, and not when they change", async () => {
    const services = sample();
    const input = { targets: [{ instrument: "KO_US_EQ", weight: 0.9 }], cashWeight: 0.1 };
    await services.targets.set("demo", input);
    const notified = (await services.targets.check(new Date("2026-10-01T10:00:00Z")))[0]!;
    expect(notified.notified).toBe(true);
    const kept = await services.targets.set("demo", input, new Date("2026-10-01T11:00:00Z"));
    expect(kept.lastNotifiedAt).toBe("2026-10-01T10:00:00.000Z");
    expect((await services.targets.check(new Date("2026-10-01T12:00:00Z")))[0]!.notified).toBe(false);
    const changed = await services.targets.set("demo", { ...input, driftThreshold: 0.04 });
    expect(changed.lastNotifiedAt).toBeUndefined();
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
    // Nothing is sold, so the buys and their fee take the cash free above the 10% cash target, shared by how far
    // each target is below: Coca-Cola's dollar buy is converted, the euro one is not.
    const ko = read.holdings.find((holding) => holding.ticker === "KO_US_EQ")!.weight;
    const spare = (read.availableCash ?? read.cash) - 0.1 * read.totalValue;
    expect(rebalance.sold).toBe(0);
    expect(rebalance.bought + rebalance.fxFee).toBeCloseTo(spare, 0);
    expect(rebalance.buysScaled).toBeLessThan(1);
    expect(rebalance.converted / rebalance.bought).toBeCloseTo((0.5 - ko) / (0.5 - ko + 0.2), 2);
    expect(rebalance.unknownCurrency).toBeUndefined();
    expect(rebalance.fxFee).toBeCloseTo(rebalance.converted * 0.0015, 2);
  });

  it("counts a target not held as converted when the instrument list can't be read", async () => {
    const services = sample();
    await services.targets.set("demo", { targets: [{ instrument: "KO_US_EQ", weight: 0.5 }, { instrument: "ASMLa_EQ", weight: 0.2 }], cashWeight: 0.1 });
    const read = await services.insights.allocation("demo");
    services.trading.instruments = async () => { throw new Error("down"); };
    const { drift } = await services.targets.withDrift(read);
    expect(drift?.rows.find((row) => row.ticker === "ASMLa_EQ")?.currency).toBeUndefined();
    expect(drift?.rebalance?.unknownCurrency).toBe(1);
  });

  it("says in the tools' text what a rebalance trades and what converting costs", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const services = sample();
    const server = createMcpServer(services, services.config, async () => "<html></html>", new Set(["trade:read"]));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    await services.targets.set("demo", { targets: [{ instrument: "KO_US_EQ", weight: 0.3 }, { instrument: "VUSAl_EQ", weight: 0.2 }], cashWeight: 0.1, sellUntargeted: true });
    const analysis = await client.callTool({ name: "analyze_portfolio_allocation", arguments: { environment: "demo" } });
    expect(JSON.stringify(analysis.content)).toMatch(/a rebalance to them about \d+ EUR traded and at most [\d.]+ EUR in conversion fees/);
    expect((analysis.structuredContent as { fxFeeRate?: number }).fxFeeRate).toBe(0.0015);
    const plan = await client.callTool({ name: "plan_portfolio_rebalance", arguments: { environment: "demo" } });
    const lead = (plan.content as Array<{ text: string }>)[0]!.text.split("\n")[0]!;
    expect(lead).toMatch(/^Rebalance plan: \d+ trade\(s\) \(buys [\d.]+ EUR, sells [\d.]+ EUR, at most [\d.]+ EUR in conversion fees\)/);
    // A plan that only buys, in euros, names neither sells nor a fee.
    const euros = await client.callTool({ name: "plan_portfolio_rebalance", arguments: { environment: "demo", targets: [{ ticker: "EUNLd_EQ", weight: 0.05 }] } });
    expect((euros.content as Array<{ text: string }>)[0]!.text).toMatch(/^Rebalance plan: 1 trade\(s\) \(buys [\d.]+ EUR\)\./);
    // With a band, only what is further off than it; the basket says so in its title.
    const banded = await client.callTool({ name: "plan_portfolio_rebalance", arguments: { environment: "demo", targets: [{ ticker: "EUNLd_EQ", weight: 0.05 }, { ticker: "KO_US_EQ", weight: 0.3 }], band: 0.05 } });
    const bandedText = (banded.content as Array<{ text: string }>)[0]!.text;
    expect(bandedText).toMatch(/^Rebalance plan of the targets more than 5 points off(, 1 target left as it is|, \d+ targets left as they are)?: \d+ trade/);
    expect((banded.structuredContent as { rebalance: { band?: number }; title: string })).toMatchObject({ rebalance: { band: 0.05 }, title: "Rebalance what drifted" });
    // Targets three of which are more than 5 points under: the analysis says what rebalancing only those would trade.
    await services.targets.set("demo", { targets: ["MSFT_US_EQ", "NVDA_US_EQ", "AAPL_US_EQ", "VUSAl_EQ"].map((instrument) => ({ instrument, weight: 0.238 })), cashWeight: 0.048 });
    const over = await client.callTool({ name: "analyze_portfolio_allocation", arguments: { environment: "demo" } });
    expect(JSON.stringify(over.content)).toMatch(/a rebalance to them about \d+ EUR traded[^;]*, only the 3 over the threshold about \d+ EUR traded/);
    await client.close();
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
