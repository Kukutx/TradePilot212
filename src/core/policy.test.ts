import { describe, expect, it } from "vitest";
import type { Instrument, OrderDraft, Position } from "../shared/contracts.js";
import type { TradingPolicy } from "../shared/automation.js";
import { createConfig } from "./config.js";
import { addUsage, blockingChecks, EMPTY_USAGE, evaluatePolicy, usageKey } from "./policy.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "Vanguard S&P 500", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };
const draft: OrderDraft = { environment: "live", ticker: "VUSA_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 100, referencePriceAt: new Date().toISOString() };
const position: Position = { instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 };
const account = { currency: "EUR", totalValue: 5000, cash: { availableToTrade: 4000 } };
const base: TradingPolicy = { maxPositionWeight: 0, dailyOrderLimit: 0, dailyNotionalLimit: 0, allowedTickers: [], blockedTickers: [], allowedTypes: [], marketOrdersWhenClosed: true, maxReferenceAgeSeconds: 0 };
const rules = (policy: Partial<TradingPolicy>, extra: Partial<Parameters<typeof evaluatePolicy>[1]> = {}) =>
  evaluatePolicy({ ...base, ...policy }, { draft, instrument, position, account, estimatedNotional: 100, usage: EMPTY_USAGE, ...extra });

describe("policy engine", () => {
  it("applies the configured rules to Live and keeps Demo relaxed by default", () => {
    const config = createConfig({ POLICY_MAX_POSITION_WEIGHT: "0.1", POLICY_ALLOWED_TYPES: "etf, stock" });
    expect(config.policy.live.maxPositionWeight).toBe(0.1);
    expect(config.policy.live.allowedTypes).toEqual(["ETF", "STOCK"]);
    expect(config.policy.live.marketOrdersWhenClosed).toBe(false);
    expect(config.policy.demo.maxPositionWeight).toBe(0);
    expect(createConfig({ POLICY_APPLY_TO: "both" }).policy.demo.dailyOrderLimit).toBe(20);
    expect(() => createConfig({ POLICY_MAX_POSITION_WEIGHT: "25" })).toThrow(/fraction/);
  });

  it("blocks a buy that would push one holding over the weight cap", () => {
    const checks = rules({ maxPositionWeight: 0.2 }, { estimatedNotional: 100 });
    expect(checks[0]).toMatchObject({ rule: "max_position_weight", status: "block" });
    expect(rules({ maxPositionWeight: 0.25 })[0]?.status).toBe("pass");
    expect(rules({ maxPositionWeight: 0.2 }, { draft: { ...draft, side: "sell" } })).toEqual([]);
  });

  it("skips the weight rule when the currencies differ", () => {
    expect(rules({ maxPositionWeight: 0.2 }, { account: { ...account, currency: "USD" } })[0]?.status).toBe("skip");
  });

  it("enforces daily order and value budgets", () => {
    expect(blockingChecks(rules({ dailyOrderLimit: 3 }, { usage: { orders: 3, notional: 0 } }))).toHaveLength(1);
    expect(blockingChecks(rules({ dailyNotionalLimit: 250 }, { usage: { orders: 1, notional: 200 } }))[0]?.rule).toBe("daily_notional_limit");
    expect(addUsage({ orders: 1, notional: 10 }, undefined)).toEqual({ orders: 2, notional: 10 });
    expect(addUsage({ orders: 1, notional: 10 }, 50)).toEqual({ orders: 2, notional: 60 });
  });

  it("applies allow and block lists, and type limits only to buys", () => {
    expect(rules({ allowedTickers: ["AAPL_US_EQ"] })[0]?.status).toBe("block");
    expect(rules({ blockedTickers: ["VUSA_EQ"] })[0]?.status).toBe("block");
    expect(rules({ allowedTypes: ["STOCK"] })[0]?.status).toBe("block");
    expect(rules({ allowedTypes: ["STOCK"] }, { draft: { ...draft, side: "sell" } })).toEqual([]);
  });

  it("blocks Market orders while closed unless the policy allows queueing", () => {
    const market = { ticker: "VUSA_EQ", session: "closed" as const, isOpen: false, checkedAt: new Date().toISOString() };
    expect(rules({ marketOrdersWhenClosed: false }, { market })[0]?.rule).toBe("market_closed");
    expect(rules({ marketOrdersWhenClosed: true }, { market })).toEqual([]);
    expect(rules({ marketOrdersWhenClosed: false }, { market, draft: { ...draft, type: "limit", limitPrice: 99 } })).toEqual([]);
  });

  it("requires a fresh reference price when configured", () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    expect(rules({ maxReferenceAgeSeconds: 120 }, { draft: { ...draft, referencePriceAt: old } })[0]?.status).toBe("block");
    expect(rules({ maxReferenceAgeSeconds: 120 })[0]?.status).toBe("pass");
  });
});

describe("the day the daily limits count", () => {
  it("is the day in TIMEZONE, so they reset at local midnight", () => {
    const late = new Date("2026-10-30T23:30:00Z");
    expect(usageKey("live", late)).toBe("usage:live:2026-10-30");
    expect(usageKey("live", late, "Europe/Berlin")).toBe("usage:live:2026-10-31");
    expect(usageKey("live", new Date("2026-10-31T02:00:00Z"), "America/Los_Angeles")).toBe("usage:live:2026-10-30");
  });
});
