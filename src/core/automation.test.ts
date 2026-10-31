import { describe, expect, it, vi } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { nextRunAt, planLimitPrice } from "./automation.js";
import { basketNotes } from "./trading-service.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";

const etf = (ticker: string): Instrument => ({ ticker, name: `${ticker} ETF`, shortName: ticker.split("_")[0]!, currencyCode: "EUR", type: "ETF" });
const instruments = [etf("VUSA_EQ"), etf("AGGH_EQ"), etf("EQQQ_EQ")];
const positions: Position[] = [
  { instrument: instruments[0]!, quantity: 30, quantityAvailableForTrading: 30, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 },
  { instrument: instruments[1]!, quantity: 100, quantityAvailableForTrading: 100, quantityInPies: 0, averagePricePaid: 5, currentPrice: 5 },
];

/** A fake Trading 212: records every write, fails writes for tickers listed in `failures`, and lists `orders` as pending. */
function broker(failures: Record<string, number> = {}, orders: unknown[] = [], held: Position[] = positions) {
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
    if (url.endsWith("/equity/metadata/instruments")) return json([...instruments, ...held.map((position) => position.instrument).filter((instrument) => !instruments.includes(instrument))]);
    if (url.endsWith("/equity/positions")) return json(held);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 5000, cash: { availableToTrade: 1500 } });
    if (url.endsWith("/equity/orders")) return json(orders);
    return json([]);
  }) as typeof fetch;
  return { fetcher, writes };
}

function setup(env: RuntimeEnv = {}, failures: Record<string, number> = {}, orders: unknown[] = [], held: Position[] = positions) {
  const fake = broker(failures, orders, held);
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

describe("funding sells", () => {
  const basket = (independentSells?: boolean) => ({
    environment: "demo" as const, purpose: "rebalance" as const, title: "Rebalance",
    ...(independentSells ? { independentSells } : {}),
    drafts: [
      { environment: "demo" as const, ticker: "VUSA_EQ", side: "sell" as const, type: "market" as const, quantity: 2, referencePrice: 100 },
      { environment: "demo" as const, ticker: "AGGH_EQ", side: "buy" as const, type: "market" as const, quantity: 10, referencePrice: 5 },
    ],
  });

  it("does not send the buys when the sell that funds them is rejected", async () => {
    const { trading, writes } = setup({}, { VUSA_EQ: 400 });
    const result = await trading.executeBasket((await trading.prepareBasket(basket())).token);
    expect(result.status).toBe("rejected");
    expect(result.legs[1]?.skipped).toMatch(/sell of VUSA_EQ that funds it was rejected/);
    expect(writes).toHaveLength(1);
  });

  it("still sends the buys when the sells were marked independent", async () => {
    const { trading, writes } = setup({}, { VUSA_EQ: 400 });
    const result = await trading.executeBasket((await trading.prepareBasket(basket(true))).token);
    expect(result.status).toBe("partial");
    expect(writes).toHaveLength(2);
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

  it("drafts one stop per holding without a full stop, largest first, and sends them as sell stops", async () => {
    const { trading, writes } = setup();
    const draft = await trading.stopsBasket("demo");
    expect(draft.purpose).toBe("protective");
    // The widget recognises these sentences to translate them (src/ui/lib/messages.test.ts).
    expect(draft.notes).toEqual([
      "Each order stays at Trading 212 until it triggers or you cancel it.",
      "A holding that already has a stop gets one at the same price for its uncovered shares; the others start 8% below the last price.",
      "A Stop order becomes a Market order when triggered, so a gap can fill it below the stop price.",
    ]);
    expect(draft.legs.map((leg) => [leg.draft.ticker, leg.draft.type, leg.draft.quantity, leg.draft.stopPrice, leg.draft.timeValidity])).toEqual([
      ["VUSA_EQ", "stop", 30, 92, "GOOD_TILL_CANCEL"],
      ["AGGH_EQ", "stop", 100, 4.6, "GOOD_TILL_CANCEL"],
    ]);
    expect((await trading.stopsBasket("demo", { dropPercent: 10, tickers: ["AGGH"] })).legs.map((leg) => [leg.draft.ticker, leg.draft.stopPrice])).toEqual([["AGGH_EQ", 4.5]]);
    const preview = await trading.prepareBasket({ environment: "demo", purpose: draft.purpose, title: draft.title, drafts: draft.legs.map((leg) => leg.draft) });
    expect((await trading.executeBasket(preview.token)).status).toBe("submitted");
    expect(writes.map((write) => [write.path, write.body.ticker, write.body.quantity, write.body.stopPrice])).toEqual([
      ["/api/v0/equity/orders/stop", "VUSA_EQ", -30, 92],
      ["/api/v0/equity/orders/stop", "AGGH_EQ", -100, 4.6],
    ]);
  });

  it("ranks holdings by account-currency value and puts one it cannot convert last", async () => {
    // 1000 pence-quoted shares at 250 GBX: 250000 in the quote currency, but no valuation and no GBP rate to convert it.
    const lgen: Position = { instrument: { ticker: "LGENl_EQ", name: "Legal & General", shortName: "LGEN", currencyCode: "GBX", type: "STOCK" }, quantity: 1000, quantityAvailableForTrading: 1000, quantityInPies: 0, averagePricePaid: 240, currentPrice: 250 };
    const { trading } = setup({}, {}, [], [lgen, ...positions]);
    expect((await trading.stopsBasket("demo")).legs.map((leg) => leg.draft.ticker)).toEqual(["VUSA_EQ", "AGGH_EQ", "LGENl_EQ"]);
  });

  it("covers only the shares an existing stop leaves, at that stop's price, and says when nothing is left", async () => {
    const partly = setup({}, {}, [{ id: 7, ticker: "VUSA_EQ", type: "STOP", side: "SELL", quantity: -10, stopPrice: 95 }]);
    expect((await partly.trading.stopsBasket("demo")).legs.map((leg) => [leg.draft.ticker, leg.draft.quantity, leg.draft.stopPrice, leg.reason])).toEqual([
      ["VUSA_EQ", 20, 95, "Matches the existing stop"],
      ["AGGH_EQ", 100, 4.6, "8% below the last price"],
    ]);
    const full = setup({}, {}, [
      { id: 7, ticker: "VUSA_EQ", type: "STOP", side: "SELL", quantity: -30, stopPrice: 95 },
      { id: 8, ticker: "AGGH_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -100, stopPrice: 4.5, limitPrice: 4.4 },
    ]);
    await expect(full.trading.stopsBasket("demo")).rejects.toThrow(/No holding has shares free to sell that a pending stop-loss does not already cover/);
    await expect(full.trading.stopsBasket("demo", { tickers: ["VUSA"] })).rejects.toThrow(/None of those holdings has shares free to sell/);
    // A ticker that is not held is named rather than skipped.
    await expect(partly.trading.stopsBasket("demo", { tickers: ["EQQQ"] })).rejects.toThrow(/no EQQQ_EQ position to protect/);
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
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 1, hour: 15, timeZone: "UTC" }, after).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 11, hour: 15, timeZone: "UTC" }, after).toISOString()).toBe("2026-10-11T15:00:00.000Z");
    expect(nextRunAt({ frequency: "weekly", weekday: 1, hour: 15, timeZone: "UTC" }, after).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(nextRunAt({ frequency: "weekly", weekday: 7, hour: 9, timeZone: "UTC" }, after).toISOString()).toBe("2026-10-18T09:00:00.000Z");
  });

  it("runs every weekday, every other week, and on a month's last day", () => {
    const after = new Date("2026-10-09T16:00:00Z"); // a Friday, after 15:00
    const utc = { hour: 15, timeZone: "UTC" };
    expect(nextRunAt({ frequency: "daily", ...utc }, after).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(nextRunAt({ frequency: "daily", ...utc }, new Date("2026-10-13T09:00:00Z")).toISOString()).toBe("2026-10-13T15:00:00.000Z");
    // Every other Monday from 12 October: not the 19th.
    const fortnight = { frequency: "biweekly" as const, weekday: 1, anchorDay: "2026-10-12", ...utc };
    expect(nextRunAt(fortnight, new Date("2026-10-12T16:00:00Z")).toISOString()).toBe("2026-10-26T15:00:00.000Z");
    expect(nextRunAt(fortnight, new Date("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-11-09T15:00:00.000Z");
    // 31 is the month's last day; 30 is the 28th in a February.
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 31, ...utc }, new Date("2026-02-01T00:00:00Z")).toISOString()).toBe("2026-02-28T15:00:00.000Z");
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 31, ...utc }, new Date("2026-03-01T00:00:00Z")).toISOString()).toBe("2026-03-31T15:00:00.000Z");
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 30, ...utc }, new Date("2028-02-01T00:00:00Z")).toISOString()).toBe("2028-02-29T15:00:00.000Z");
  });

  it("keeps a plan's hour in its own zone through summer time", () => {
    const london = { frequency: "weekly" as const, weekday: 1, hour: 15, timeZone: "Europe/London" };
    // 15:00 in London is 14:00 UTC in summer and 15:00 UTC in winter.
    expect(nextRunAt(london, new Date("2026-10-19T00:00:00Z")).toISOString()).toBe("2026-10-19T14:00:00.000Z");
    expect(nextRunAt(london, new Date("2026-10-26T00:00:00Z")).toISOString()).toBe("2026-10-26T15:00:00.000Z");
    // The hour the clocks skip (01:00 on 29 March 2026 in London) is due as the clocks jump.
    expect(nextRunAt({ frequency: "monthly", dayOfMonth: 29, hour: 1, timeZone: "Europe/London" }, new Date("2026-03-28T00:00:00Z")).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    // A day in Shanghai starts the evening before in UTC.
    expect(nextRunAt({ frequency: "daily", hour: 9, timeZone: "Asia/Shanghai" }, new Date("2026-10-12T02:00:00Z")).toISOString()).toBe("2026-10-13T01:00:00.000Z");
  });

  it("schedules a new plan's hour in its zone, the server's when an hour comes alone, and 15:00 UTC with neither", async () => {
    const { automation } = setup({ TIMEZONE: "Europe/London" });
    const now = new Date("2026-10-11T12:00:00Z");
    const zoned = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "weekly", weekday: 1, hour: 9 }, now);
    expect(zoned).toMatchObject({ hour: 9, timeZone: "Europe/London", nextRunAt: "2026-10-12T08:00:00.000Z" });
    const plain = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "daily" }, now);
    expect(plain).toMatchObject({ hour: 15, timeZone: "UTC", nextRunAt: "2026-10-12T15:00:00.000Z" });
    expect(plain.weekday).toBeUndefined();
    const fortnight = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "biweekly", weekday: 3, hour: 15, timeZone: "UTC" }, now);
    expect(fortnight).toMatchObject({ anchorDay: "2026-10-14", nextRunAt: "2026-10-14T15:00:00.000Z" });
    await expect(automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "daily", timeZone: "Mars/Olympus" }, now)).rejects.toThrow(/Unknown time zone/);
  });

  it("reads a plan saved before 2.79 with its UTC hour", async () => {
    const { automation, store } = setup();
    await store.put("plan:dca_old", { id: "dca_old", environment: "demo", label: "Old", legs: [{ ticker: "VUSAl_EQ", amount: 50 }], frequency: "monthly", dayOfMonth: 3, hourUtc: 14, autoExecute: false, paused: false, nextRunAt: "2026-11-03T14:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
    const plan = await automation.getPlan("dca_old");
    expect(plan).toMatchObject({ hour: 14, timeZone: "UTC" });
    expect("hourUtc" in plan).toBe(false);
    expect((await automation.listPlans())[0]).toMatchObject({ hour: 14, timeZone: "UTC" });
    const later = await automation.updatePlan("dca_old", { dayOfMonth: 4 }, new Date("2026-10-11T12:00:00Z"));
    expect(later.nextRunAt).toBe("2026-11-04T14:00:00.000Z");
  });

  it("skips the next run, or the one waiting, and says so", async () => {
    const { automation } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 5 }, new Date("2026-10-01T00:00:00Z"));
    expect(plan.nextRunAt).toBe("2026-10-05T15:00:00.000Z");
    const skipped = await automation.skipNextRun(plan.id, new Date("2026-10-02T00:00:00Z"));
    expect(skipped.nextRunAt).toBe("2026-11-05T15:00:00.000Z");
    expect(skipped.lastOutcome).toMatch(/Skipped the run due 2026-10-05/);
    // Overdue (waiting for you): the waiting run is the one left out.
    const again = await automation.skipNextRun(plan.id, new Date("2026-11-06T00:00:00Z"));
    expect(again.nextRunAt).toBe("2026-12-05T15:00:00.000Z");
  });

  it("never lets a Live plan run unattended", async () => {
    const { automation } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    await expect(automation.createPlan({ environment: "live", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true })).rejects.toThrow(/only available for Demo/);
    const plan = await automation.createPlan({ environment: "live", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1 });
    await expect(automation.updatePlan(plan.id, { autoExecute: true })).rejects.toThrow(/only available for Demo/);
  });

  it("announces a due plan once and waits for confirmation without Demo automation", async () => {
    // The store expires the announcement against the clock, so the clock is the plan's due time here.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { automation, trading, writes } = setup();
      const plan = await automation.createPlan({ environment: "demo", label: "Monthly", legs: [{ ticker: "VUSA", amount: 250 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
      const due = new Date(Date.parse(plan.nextRunAt) + 60_000);
      vi.setSystemTime(due);
      expect((await automation.runDuePlans(due))[0]?.mode).toBe("awaiting_confirmation");
      await automation.runDuePlans(due);
      expect((await trading.getActivity("demo")).filter((event) => event.type === "plan_due")).toHaveLength(1);
      expect(writes).toHaveLength(0);

      const review = await automation.reviewPlan(plan.id);
      expect(review.legs[0]?.draft).toMatchObject({ ticker: "VUSA_EQ", side: "buy", quantity: 2.5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invests a plan's amount across the saved targets, most to the furthest below", async () => {
    const { automation, targets } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "By targets", legs: [], targetAmount: 1000, frequency: "monthly", dayOfMonth: 1 });
    expect(plan.legs).toEqual([]);
    // Nothing saved yet: nothing to buy, and the plan says why.
    expect((await automation.buildBasket(plan)).skipped.join(" ")).toMatch(/No target weights are saved for DEMO/);
    // VUSA holds 3000 and AGGH 500; with 1000 more, an even split wants 2250 each, so AGGH gets it all.
    await targets.set("demo", { targets: [{ instrument: "VUSA_EQ", weight: 0.5 }, { instrument: "AGGH_EQ", weight: 0.5 }] });
    expect((await automation.reviewPlan(plan.id)).legs.map((leg) => [leg.draft.ticker, leg.draft.quantity])).toEqual([["AGGH_EQ", 200]]);
    // 80/20 wants 3600 and 900: 600 to VUSA and 400 to AGGH.
    await targets.set("demo", { targets: [{ instrument: "VUSA_EQ", weight: 0.8 }, { instrument: "AGGH_EQ", weight: 0.2 }] });
    expect((await automation.reviewPlan(plan.id)).legs.map((leg) => [leg.draft.ticker, leg.draft.quantity])).toEqual([["VUSA_EQ", 6], ["AGGH_EQ", 80]]);
    await expect(automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 1 }], targetAmount: 10, frequency: "monthly", dayOfMonth: 1 })).rejects.toThrow(/either legs or targetAmount/);
    const switched = await automation.updatePlan(plan.id, { legs: [{ ticker: "VUSA", amount: 50 }] });
    expect(switched.targetAmount).toBeUndefined();
    expect((await automation.updatePlan(plan.id, { targetAmount: 300 }))).toMatchObject({ legs: [], targetAmount: 300 });
  });

  it("does not send a plan by targets when the targets change while it is priced", async () => {
    const { automation, targets, trading, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    await targets.set("demo", { targets: [{ instrument: "VUSA_EQ", weight: 0.5 }, { instrument: "AGGH_EQ", weight: 0.5 }] }, new Date("2026-09-01T00:00:00Z"));
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [], targetAmount: 1000, frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const due = Date.parse(plan.nextRunAt) + 60_000;
    const prepare = trading.prepareBasket.bind(trading);
    trading.prepareBasket = async (...args) => {
      const preview = await prepare(...args);
      await targets.set("demo", { targets: [{ instrument: "VUSA_EQ", weight: 0.8 }, { instrument: "AGGH_EQ", weight: 0.2 }] }, new Date("2026-09-30T00:00:00Z"));
      return preview;
    };
    expect(await automation.runDuePlans(new Date(due))).toEqual([]);
    expect(writes).toHaveLength(0);
    // The next run window splits the amount by the new targets.
    trading.prepareBasket = prepare;
    const [report] = await automation.runDuePlans(new Date(due + 11 * 60_000));
    expect(report?.mode).toBe("auto");
    expect(writes.map((write) => write.body.ticker)).toEqual(["VUSA_EQ", "AGGH_EQ"]);
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
  it("never re-sends an unattended plan after an unclear or rejected result", async () => {
    const { automation, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" }, { VUSA_EQ: 503 });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const due = Date.parse(plan.nextRunAt);
    expect((await automation.runDuePlans(new Date(due + 60_000)))[0]?.mode).toBe("auto");
    for (const minutes of [12, 25, 60]) await automation.runDuePlans(new Date(due + minutes * 60_000));
    expect(writes).toHaveLength(1);
    const stored = await automation.getPlan(plan.id);
    expect(Date.parse(stored.nextRunAt)).toBeGreaterThan(due);
  });

  it("changes a plan's schedule on update and recomputes the due date", async () => {
    const { automation } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1 });
    const now = new Date("2026-10-11T12:00:00Z");
    expect((await automation.updatePlan(plan.id, { dayOfMonth: 15 }, now)).nextRunAt).toBe("2026-10-15T15:00:00.000Z");
    const weekly = await automation.updatePlan(plan.id, { frequency: "weekly", weekday: 1, hour: 9 }, now);
    expect(weekly).toMatchObject({ frequency: "weekly", weekday: 1, hour: 9, timeZone: "UTC", nextRunAt: "2026-10-12T09:00:00.000Z" });
    expect(weekly.dayOfMonth).toBeUndefined();
    await expect(automation.updatePlan(plan.id, { frequency: "monthly" }, now)).rejects.toThrow(/dayOfMonth/);
  });

  it("does not run a period again when its schedule moves after a run, and resumes from now", async () => {
    const { automation, store } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1 }, new Date("2026-09-15T00:00:00Z"));
    await store.put(`plan:${plan.id}`, { ...plan, lastRunAt: "2026-10-01T15:01:00.000Z", nextRunAt: "2026-11-01T15:00:00.000Z" });
    const moved = await automation.updatePlan(plan.id, { hour: 18 }, new Date("2026-10-01T16:00:00Z"));
    expect(moved.nextRunAt).toBe("2026-11-01T18:00:00.000Z");
    expect(moved.lastRunAt).toBe("2026-10-01T15:01:00.000Z");

    await automation.updatePlan(plan.id, { paused: true }, new Date("2026-10-02T00:00:00Z"));
    const resumed = await automation.updatePlan(plan.id, { paused: false }, new Date("2026-12-10T00:00:00Z"));
    expect(resumed.nextRunAt).toBe("2027-01-01T18:00:00.000Z");
  });

  it("waits for the user when an unattended run may already have been sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { automation, store, writes, trading } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
      const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
      await store.put(`plan:${plan.id}`, { ...plan, inFlightDueAt: plan.nextRunAt });
      const due = new Date(Date.parse(plan.nextRunAt) + 60_000);
      vi.setSystemTime(due);
      expect((await automation.runDuePlans(due))[0]?.mode).toBe("awaiting_confirmation");
      vi.setSystemTime(due.getTime() + 15 * 60_000);
      await automation.runDuePlans(new Date(due.getTime() + 15 * 60_000));
      expect(writes).toHaveLength(0);
      expect((await trading.getActivity("demo")).filter((event) => event.type === "plan_due")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a basket priced before the plan's legs were changed", async () => {
    const { automation, trading, store, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const prepare = trading.prepareBasket.bind(trading);
    trading.prepareBasket = async (...args) => {
      const current = (await automation.getPlan(plan.id));
      await store.put(`plan:${plan.id}`, { ...current, legs: [{ ticker: "EQQQ_EQ", amount: 100 }] });
      return prepare(...args);
    };
    expect(await automation.runDuePlans(new Date(Date.parse(plan.nextRunAt) + 60_000))).toEqual([]);
    expect(writes).toHaveLength(0);
    expect((await automation.getPlan(plan.id))).toMatchObject({ nextRunAt: plan.nextRunAt, legs: [{ ticker: "EQQQ_EQ" }] });
  });

  it("keeps an unattended Market leg due while the market hours cannot be read", async () => {
    const { automation, insights, writes } = setup({ AUTOMATION_DEMO_ENABLED: "true" });
    insights.tryMarketStatus = async () => undefined;
    const plan = await automation.createPlan({ environment: "demo", label: "x", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1, autoExecute: true }, new Date("2026-09-15T00:00:00Z"));
    const [report] = await automation.runDuePlans(new Date(Date.parse(plan.nextRunAt) + 60_000));
    expect(report).toMatchObject({ mode: "skipped" });
    expect(report?.message).toMatch(/hours unknown/);
    expect(writes).toHaveLength(0);
    expect((await automation.getPlan(plan.id)).nextRunAt).toBe(plan.nextRunAt);
  });

  it("counts a plan run early as the upcoming run instead of buying twice", async () => {
    const { automation, trading } = setup();
    const plan = await automation.createPlan({ environment: "demo", label: "Monthly", legs: [{ ticker: "VUSA", amount: 100 }], frequency: "monthly", dayOfMonth: 1 });
    const review = await automation.reviewPlan(plan.id);
    const preview = await trading.prepareBasket({ environment: review.environment, purpose: review.purpose, title: review.title, drafts: review.legs.map((leg) => leg.draft), planId: plan.id });
    expect((await trading.executeBasket(preview.token)).status).toBe("submitted");
    const stored = await automation.getPlan(plan.id);
    expect(stored.nextRunAt).toBe(nextRunAt(plan, new Date(Date.parse(plan.nextRunAt) + 1)).toISOString());
  });

  it("converts a plan amount in the account currency into shares quoted in pence", async () => {
    const vusa: Instrument = { ticker: "VUSAl_EQ", name: "Vanguard S&P 500 (Dist)", shortName: "VUSA", currencyCode: "GBX", type: "ETF" };
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/equity/metadata/instruments")) return json([vusa]);
      if (url.endsWith("/equity/positions")) return json([{ instrument: vusa, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 8000, currentPrice: 8475, walletImpact: { currentValue: 1000 } }]);
      if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 2000, cash: { availableToTrade: 1000 } });
      return json([]);
    }) as typeof fetch;
    const { automation } = createServices({ config: createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" }), store: new MemoryStateStore(), fetcher });
    const plan = await automation.createPlan({ environment: "demo", label: "VUSA", legs: [{ ticker: "VUSAl_EQ", amount: 169.5 }], frequency: "monthly", dayOfMonth: 1 });
    // 169.50 EUR at 84.75 GBX per EUR is 14,365 GBX: 1.695 shares at 8,475 GBX.
    const review = await automation.reviewPlan(plan.id);
    expect(review.legs[0]?.draft.quantity).toBe(1.695);
  });

  it("keeps rebalance basket notes within what the review accepts", () => {
    const skipped = Array.from({ length: 30 }, (_, i) => ({ ticker: `T${i}`, reason: "Quoted in USD; pass fxRates.USD." }));
    const notes = basketNotes({ notes: ["a", "b"], skipped });
    expect(notes).toHaveLength(3);
    expect(notes[2]).toMatch(/Skipped 30 instrument/);
    expect(notes.every((note) => note.length <= 500)).toBe(true);
  });
});
