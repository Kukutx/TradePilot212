import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { nextRunAt, planLimitPrice } from "./automation.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";

const etf = (ticker: string): Instrument => ({ ticker, name: `${ticker} ETF`, shortName: ticker.split("_")[0]!, currencyCode: "EUR", type: "ETF" });
const instruments = [etf("VUSA_EQ"), etf("AGGH_EQ"), etf("EQQQ_EQ")];
const positions: Position[] = [
  { instrument: instruments[0]!, quantity: 30, quantityAvailableForTrading: 30, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 },
  { instrument: instruments[1]!, quantity: 100, quantityAvailableForTrading: 100, quantityInPies: 0, averagePricePaid: 5, currentPrice: 5 },
];

/** A fake Trading 212: records every write, and fails writes for tickers listed in `failures`. */
function broker(failures: Record<string, number> = {}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ path: new URL(url).pathname, body });
      const status = failures[String(body.ticker)];
      return status ? json({ code: "Rejected" }, status) : json({ id: writes.length, ...body });
    }
    if (url.endsWith("/equity/metadata/instruments")) return json(instruments);
    if (url.endsWith("/equity/positions")) return json(positions);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 5000, cash: { availableToTrade: 1500 } });
    return json([]);
  }) as typeof fetch;
  return { fetcher, writes };
}

function setup(env: RuntimeEnv = {}, failures: Record<string, number> = {}) {
  const fake = broker(failures);
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", T212_LIVE_API_KEY: "k", T212_LIVE_API_SECRET: "s", ...env });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher: fake.fetcher }), writes: fake.writes, store };
}

describe("order baskets", () => {
  it("sends sells before buys after one confirmation", async () => {
    const { trading, writes } = setup();
    const preview = await trading.prepareBasket({
      environment: "demo", purpose: "rebalance", title: "Rebalance",
      drafts: [
        { environment: "demo", ticker: "AGGH", side: "buy", type: "market", quantity: 10, referencePrice: 5 },
        { environment: "demo", ticker: "VUSA_EQ", side: "sell", type: "market", quantity: 2, referencePrice: 100 },
      ],
    });
    expect(preview.legs.map((leg) => leg.draft.side)).toEqual(["sell", "buy"]);
    expect(preview.legs[1]?.draft.ticker).toBe("AGGH_EQ");
    const result = await trading.executeBasket(preview.token);
    expect(result.status).toBe("submitted");
    expect(writes.map((write) => [write.path, write.body.quantity])).toEqual([["/api/v0/equity/orders/market", -2], ["/api/v0/equity/orders/market", 10]]);
    await expect(trading.executeBasket(preview.token)).rejects.toThrow(/invalid or expired/);
  });

  it("checks cumulative sells within a basket but not for protective orders", async () => {
    const { trading } = setup();
    const sells = [
      { environment: "demo" as const, ticker: "VUSA_EQ", side: "sell" as const, type: "stop" as const, quantity: 30, stopPrice: 80, timeValidity: "GOOD_TILL_CANCEL" as const },
      { environment: "demo" as const, ticker: "VUSA_EQ", side: "sell" as const, type: "limit" as const, quantity: 30, limitPrice: 130, timeValidity: "GOOD_TILL_CANCEL" as const },
    ];
    await expect(trading.prepareBasket({ environment: "demo", purpose: "custom", title: "x", drafts: sells })).rejects.toThrow(/Leg 2.*exceeds available quantity/);
    const preview = await trading.prepareBasket({ environment: "demo", purpose: "protective", title: "x", drafts: sells, independentSells: true });
    expect(preview.legs).toHaveLength(2);
  });

  it("stops the remaining orders after an uncertain result and never retries", async () => {
    const { trading, writes } = setup({}, { VUSA_EQ: 503 });
    const preview = await trading.prepareBasket({
      environment: "demo", purpose: "custom", title: "x",
      drafts: [
        { environment: "demo", ticker: "VUSA_EQ", side: "sell", type: "market", quantity: 1, referencePrice: 100 },
        { environment: "demo", ticker: "AGGH_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 5 },
      ],
    });
    const result = await trading.executeBasket(preview.token);
    expect(result.status).toBe("stopped");
    expect(result.legs[0]?.result?.status).toBe("unknown");
    expect(result.legs[0]?.result?.verificationId).toBeTruthy();
    expect(result.legs[1]?.skipped).toMatch(/uncertain/);
    expect(writes).toHaveLength(1);
  });

  it("refuses a basket that breaks the Live policy", async () => {
    const { trading } = setup({ POLICY_MAX_POSITION_WEIGHT: "0.5" });
    await expect(trading.prepareBasket({
      environment: "live", purpose: "custom", title: "x",
      drafts: [{ environment: "live", ticker: "VUSA_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 100 }],
    })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  it("counts submitted orders against the daily order limit", async () => {
    const { trading } = setup({ POLICY_APPLY_TO: "demo", POLICY_DAILY_ORDER_LIMIT: "1", POLICY_MAX_POSITION_WEIGHT: "0" });
    const order = { environment: "demo" as const, ticker: "AGGH_EQ", side: "buy" as const, type: "market" as const, quantity: 1, referencePrice: 5 };
    const preview = await trading.prepareOrder(order);
    expect(preview.policy?.find((check) => check.rule === "daily_order_limit")?.status).toBe("pass");
    expect((await trading.executeOrder(preview.token)).ok).toBe(true);
    await expect(trading.prepareOrder(order)).rejects.toThrow(/daily limit is 1/);
  });
});

describe("protective orders and rebalance drafts", () => {
  it("drafts GTC stop-loss and take-profit sells around the current price", async () => {
    const { trading } = setup();
    const draft = await trading.protectiveBasket("demo", "VUSA", { stopLossPrice: 90, takeProfitPrice: 120 });
    expect(draft.legs.map((leg) => [leg.draft.type, leg.draft.quantity, leg.draft.timeValidity])).toEqual([["stop", 30, "GOOD_TILL_CANCEL"], ["limit", 30, "GOOD_TILL_CANCEL"]]);
    await expect(trading.protectiveBasket("demo", "VUSA", { stopLossPrice: 110 })).rejects.toThrow(/below the current price/);
    await expect(trading.protectiveBasket("demo", "EQQQ", { stopLossPrice: 1 })).rejects.toThrow(/no tradable/);
  });

  it("turns a rebalance plan into a basket draft", async () => {
    const { trading } = setup();
    const plan = await trading.planRebalance("demo", [{ ticker: "VUSA", weight: 0.5 }, { ticker: "AGGH", weight: 0.2 }], { quantityDecimals: 0 });
    // 3000 VUSA → 2500 (sell 5); 500 AGGH → 1000 (buy 100)
    expect(plan.trades.map((trade) => [trade.side, trade.ticker, trade.quantity])).toEqual([["sell", "VUSA_EQ", 5], ["buy", "AGGH_EQ", 100]]);
    expect(trading.rebalanceBasket(plan).legs).toHaveLength(2);
  });
});

describe("standing plans", () => {
  it("does not send an unattended Market order while the market is closed", async () => {
    const { automation, insights, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    insights.tryMarketStatus = async (_environment, instrument) => ({ ticker: instrument.ticker, session: "closed", isOpen: false, checkedAt: new Date().toISOString() });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const [report] = await automation.runDuePlans(new Date(Date.parse(plan.nextRunAt) + 60_000));
    expect(report?.message).toMatch(/Market closed/);
    expect(writes).toHaveLength(0);
  });

  it("computes the next monthly and weekly due times", () => {
    const after = new Date("2026-10-11T12:00:00Z"); // a Sunday
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 1, hourUtc: 15 }, after).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 11, hourUtc: 15 }, after).toISOString()).toBe("2026-10-11T15:00:00.000Z");
    expect(nextRunAt({ frequency: "weekly", weekday: 1, hourUtc: 15 }, after).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(nextRunAt({ frequency: "weekly", weekday: 7, hourUtc: 9 }, after).toISOString()).toBe("2026-10-18T09:00:00.000Z");
  });

  it("never lets a Live plan run unattended", async () => {
    const { automation } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    await expect(automation.createPlan({ environment: "live", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true })).rejects.toThrow(/only available for Demo/);
    const plan = await automation.createPlan({ environment: "live", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1 });
    await expect(automation.updatePlan(plan.id, { autoExecute: true })).rejects.toThrow(/only available for Demo/);
  });

  it("announces a due plan once and waits for confirmation without Demo automation", async () => {
    const { automation, trading, writes } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "Monthly", legs: [{ ticker: "VUSA", amount: 250 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const due = new Date(Date.parse(plan.nextRunAt) + 60_000);
    expect((await automation.runDuePlans(due))[0]?.mode).toBe("awaiting_confirmation");
    await automation.runDuePlans(due);
    expect((await trading.getActivity("demo")).filter((event) => event.type === "plan_due")).toHaveLength(1);
    expect(writes).toHaveLength(0);

    const review = await automation.reviewPlan(plan.id);
    expect(review.legs[0]?.draft).toMatchObject({ ticker: "VUSA_EQ", side: "buy", quantity: 2.5 });
  });

  it("runs a due Demo plan unattended when enabled and moves it to the next date", async () => {
    const { automation, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    const plan = await automation.createPlan({ environment: "demo", label: "Weekly", legs: [{ ticker: "VUSA", amount: 100 }, { ticker: "EQQQ", amount: 100 }], frequency: "weekly", weekday: 1, autoExecute: true }, new Date("2026-10-01T00:00:00Z"));
    const due = new Date(Date.parse(plan.nextRunAt) + 60_000);
    const [report] = await automation.runDuePlans(due);
    expect(report?.mode).toBe("auto");
    expect(writes.map((write) => write.body)).toEqual([{ ticker: "VUSA_EQ", quantity: 1 }]);
    const stored = await automation.getPlan(plan.id);
    expect(Date.parse(stored.nextRunAt)).toBeGreaterThan(due.getTime());
    expect(stored.lastOutcome).toMatch(/1 of 1/);
    expect(await automation.runDuePlans(due)).toEqual([]);
  });

  it("keeps a policy-blocked Demo plan due instead of skipping its run", async () => {
    const { automation, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true", POLICY_APPLY_TO: "demo", POLICY_BLOCKED_TICKERS: "VUSA_EQ" });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const due = new Date(Date.parse(plan.nextRunAt) + 60_000);
    expect((await automation.runDuePlans(due))[0]?.mode).toBe("skipped");
    expect((await automation.getPlan(plan.id)).nextRunAt).toBe(plan.nextRunAt);
    expect(writes).toHaveLength(0);
  });
  it("places capped Day Limit buys for limit legs, even while the market is closed", async () => {
    const { automation, insights, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    insights.tryMarketStatus = async (_environment, instrument) => ({ ticker: instrument.ticker, session: "closed", isOpen: false, checkedAt: new Date().toISOString() });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 101, orderType: "limit", limitOffsetPercent: 1 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    expect(plan.legs[0]).toEqual({ ticker: "VUSA_EQ", amount: 101, orderType: "limit", limitOffsetPercent: 1 });
    const [report] = await automation.runDuePlans(new Date(Date.parse(plan.nextRunAt) + 60_000));
    expect(report?.mode).toBe("auto");
    expect(writes).toEqual([{ path: "/api/v0/equity/orders/limit", body: { ticker: "VUSA_EQ", quantity: 1, limitPrice: 101, timeValidity: "DAY" } }]);
  });

  it("rounds plan limit prices and rejects large offsets", async () => {
    expect(planLimitPrice(100, 0.5)).toBe(100.5);
    expect(planLimitPrice(0.123456, 1)).toBe(0.1247);
    const { automation } = setup();
    await expect(automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100, orderType: "limit", limitOffsetPercent: 25 }], frequency: "monthly", dayOfMonth: 1 })).rejects.toThrow(/limitOffsetPercent/);
  });
});
