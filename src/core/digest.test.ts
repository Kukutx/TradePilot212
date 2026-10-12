import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import type { PortfolioToday } from "../shared/today.js";
import { DailyDigest, digestDay, digestDividends, digestText } from "./digest.js";
import { MemoryStateStore } from "./state-store.js";

const instrument: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };

function setup(env: Record<string, string>) {
  const hooks: string[] = [];
  const total = { value: 2000 };
  const outage = { on: false };
  const hookDown = { on: false };
  const orders: { list: unknown[] } = { list: [] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).host === "hooks.example") {
      if (hookDown.on) return new Response("down", { status: 503 });
      hooks.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response("ok");
    }
    if (url.endsWith("/equity/orders")) return json(orders.list);
    if (url.endsWith("/equity/positions")) return json([{ instrument, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100, walletImpact: { currentValue: 1000, unrealizedProfitLoss: 100 } }]);
    if (url.endsWith("/equity/account/summary") && outage.on) return new Response(JSON.stringify({ code: "Unauthorized" }), { status: 401 });
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: total.value, cash: { availableToTrade: 1000 }, investments: { unrealizedProfitLoss: 100 } });
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", NOTIFY_WEBHOOK_URL: "https://hooks.example/t", ...env });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher }), config, store, hooks, total, outage, hookDown, orders };
}

describe("daily digest", () => {
  it("formats a compact summary", () => {
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, previousTotalValue: 2000, cash: 10, unrealized: -5, positions: [{ ticker: "A", value: 5, profitLoss: 1 }], pendingOrders: 1, duePlans: ["Monthly"], triggeredAlerts: 0 }))
      .toBe("Total 2010 EUR (+10 since the last digest) · cash 10 · unrealized -5 · top: A 5 (+1) · 1 pending order(s) · due plans: Monthly");
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, cash: 10, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, filledOrders: 2, maxDrift: 0.0712 }))
      .toBe("Total 2010 EUR · cash 10 · 2 order(s) filled in the last day · largest drift from targets 7.1 points");
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 10, cash: 0, positions: [], pendingOrders: 1, duePlans: [], triggeredAlerts: 0, uncovered: ["A", "B", "C", "D", "E", "F", "G"] }))
      .toBe("Total 10 EUR · cash 0 · 1 pending order(s) · no full stop-loss: A, B, C, D, E +2");
  });

  it("leads with the holdings' move on their last session and the biggest movers", () => {
    const today: PortfolioToday = {
      kind: "portfolio_today", environment: "demo", accountCurrency: "EUR", timestamp: "2026-10-10T07:00:00Z",
      moves: [
        { ticker: "VUSAl_EQ", shortName: "VUSA", quantity: 40, day: "2026-10-09", change: -0.0233, profitLoss: -103.08 },
        { ticker: "AAPL_US_EQ", shortName: "AAPL", quantity: 12, day: "2026-10-09", change: 0.0393, profitLoss: 96.6 },
        { ticker: "TSLA_US_EQ", quantity: 0, day: "2026-10-09", profitLoss: -27.6, sold: 3 },
        { ticker: "KO_US_EQ", shortName: "KO", quantity: 25, day: "2026-10-09", missing: "lag" },
        { ticker: "MSFT_US_EQ", shortName: "MSFT", quantity: 6, day: "2026-10-09", change: -0.0119, profitLoss: -8.48 },
      ],
      total: { profitLoss: -42.56, change: -0.0085, counted: 4, of: 5 },
    };
    const day = digestDay(today)!;
    expect(day.movers.map((mover) => mover.name)).toEqual(["VUSA", "AAPL", "TSLA_US_EQ"]);
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 2010, cash: 10, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, day }))
      .toBe("Total 2010 EUR · day -42.56 (-0.85%) on 2026-10-09 for 4 of 5 instruments · movers: VUSA -2.33%, AAPL +3.93%, TSLA_US_EQ -27.6 EUR · cash 10");
    expect(digestDay({ ...today, total: undefined })).toBeUndefined();
  });

  it("reads the day for the digest's own time, and goes on without it when it fails", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    const texts: string[] = [];
    const asked: Date[] = [];
    const total = { profitLoss: 12.5, change: 0.0125, counted: 1, of: 1 };
    const moves = [{ ticker: "VUSA_EQ", shortName: "VUSA", quantity: 10, day: "2026-10-09", change: 0.0125, profitLoss: 12.5 }];
    let fail = false;
    const digest = new DailyDigest({
      config: services.config, store: services.store, trading: services.trading,
      notify: async (event) => { texts.push(event.outcome ?? ""); return true; },
      today: async (environment, now) => {
        asked.push(now);
        if (fail) throw new Error("rate limit");
        return { kind: "portfolio_today", environment, accountCurrency: "EUR", moves, total, timestamp: now.toISOString() };
      },
    });
    expect(await digest.run(new Date("2026-10-10T07:00:00Z"))).toEqual(["demo"]);
    expect(asked.map((date) => date.toISOString())).toEqual(["2026-10-10T07:00:00.000Z"]);
    expect(texts[0]).toMatch(/^Total 2000 EUR · day \+12\.5 \(\+1\.25%\) on 2026-10-09 · movers: VUSA \+1\.25% · cash 1000/);
    fail = true;
    expect(await digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(texts[1]).toBe("Total 2000 EUR (+0 since the last digest) · cash 1000 · unrealized +100 · top: VUSA_EQ 1000 (+100)");
  });

  it("names the dividends paid since the last digest and those expected in the coming week", () => {
    const position = (ticker: string, shortName: string, quantity: number) => ({ instrument: { ticker, name: shortName, shortName, currencyCode: "USD" }, quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: 1, currentPrice: 1 });
    const positions = [position("KO_US_EQ", "KO", 20), position("AAPL_US_EQ", "AAPL", 10), position("MSFT_US_EQ", "MSFT", 5)];
    const quarterly = (ticker: string, amount: number, quantity: number, days: string[]) => days.map((day) => ({ ticker, amount, quantity, paidOn: `${day}T12:00:00Z` }));
    const history = [
      ...quarterly("KO_US_EQ", 9.7, 20, ["2025-10-01", "2026-01-02", "2026-04-01", "2026-07-01", "2026-10-09"]),
      // Paid a quarter ago and due again in four days.
      ...quarterly("AAPL_US_EQ", 2.4, 10, ["2025-11-14", "2026-02-14", "2026-05-14", "2026-07-14"]),
      // Due two days ago and not paid yet.
      ...quarterly("MSFT_US_EQ", 4.15, 5, ["2025-12-08", "2026-03-08", "2026-06-08", "2026-07-08"]),
      { ticker: "SOLD_EQ", amount: 1.25, quantity: 5, paidOn: "2026-10-09T15:00:00Z" },
    ];
    const now = new Date("2026-10-10T07:00:00Z");
    const dividends = digestDividends(history, positions, { since: Date.parse("2026-10-09T07:00:00Z") }, now);
    expect(dividends.received).toEqual([{ name: "KO", amount: 9.7 }, { name: "SOLD_EQ", amount: 1.25 }]);
    // The week's first, then the one due and not paid.
    expect(dividends.expected).toEqual([
      { name: "AAPL", on: "2026-10-14", amount: 2.4, due: false },
      { name: "MSFT", on: "2026-10-08", amount: 4.15, due: true },
    ]);
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 10, cash: 0, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, dividends }))
      .toBe("Total 10 EUR · cash 0 · dividends 10.95 in: KO 9.7, SOLD_EQ 1.25 · dividends expected this week: AAPL ~2.4 10-14, MSFT ~4.15 due 10-08");
    // A payment the last digest saw is not named again.
    const ko = history.find((item) => item.ticker === "KO_US_EQ" && item.paidOn.startsWith("2026-10-09"))!;
    expect(digestDividends([{ ...ko, reference: "ko-1" }], positions, { since: Date.parse("2026-10-07T07:00:00Z"), seen: ["ko-1"] }, now).received).toEqual([]);
    // The week is seven days from today; one due more than a week ago has likely been cut or moved, and is left out.
    const expectedOn = (day: string) => {
      const at = new Date(`${day}T07:00:00Z`);
      return digestDividends(history.filter((item) => Date.parse(item.paidOn) <= at.getTime()), positions, { since: at.getTime() }, at).expected.map((payment) => `${payment.name} ${payment.on}${payment.due ? " due" : ""}`);
    };
    expect(expectedOn("2026-10-07")).toEqual(["MSFT 2026-10-08", "KO 2026-10-01 due"]);
    expect(expectedOn("2026-10-15")).toEqual(["MSFT 2026-10-08 due", "AAPL 2026-10-14 due"]);
    expect(expectedOn("2026-10-16")).toEqual(["AAPL 2026-10-14 due"]);
    // A history cut short at the page limit may lack a payment of the year before: nothing expected rather than too little.
    expect(digestDividends(history, positions, { since: Date.parse("2026-10-09T07:00:00Z"), truncated: true }, now)).toEqual({ received: dividends.received, expected: [] });
  });

  it("names the five largest dividends received and counts the rest", () => {
    const received = ["A", "B", "C", "D", "E", "F", "G"].map((name, index) => ({ name, amount: 7 - index }));
    expect(digestText({ environment: "demo", currency: "EUR", totalValue: 10, cash: 0, positions: [], pendingOrders: 0, duePlans: [], triggeredAlerts: 0, dividends: { received, expected: [] } }))
      .toBe("Total 10 EUR · cash 0 · dividends 28 in: A 7, B 6, C 5, D 4, E 3 +2");
  });

  it("names each dividend once: after days without a digest, after a failed read, and when it reaches the history late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7" });
      const texts: string[] = [];
      const reads: string[] = [];
      const history: Array<{ reference: string; ticker: string; amount: number; quantity: number; paidOn: string }> = [
        { reference: "d0", ticker: "VUSA_EQ", amount: 3, quantity: 10, paidOn: "2026-07-10T20:00:00Z" },
      ];
      let fail = false;
      const digest = new DailyDigest({
        config: services.config, store: services.store, trading: services.trading,
        notify: async (event) => { texts.push(event.outcome ?? ""); return true; },
        dividends: async (_environment, from) => {
          reads.push(from.toISOString());
          if (fail) throw new Error("rate limit");
          // Newest first, as Trading 212 lists them.
          return { items: [...history].sort((a, b) => b.paidOn.localeCompare(a.paidOn)), truncated: false };
        },
      });
      const runAt = (time: string) => { vi.setSystemTime(new Date(time)); return digest.run(new Date()); };
      const paid = (reference: string, amount: number, paidOn: string) => history.push({ reference, ticker: "VUSA_EQ", amount, quantity: 10, paidOn });

      paid("d1", 3.1, "2026-10-10T20:00:00Z");
      expect(await runAt("2026-10-11T07:00:00Z")).toEqual(["demo"]);
      // Read from the first day of this month a year ago, for the expected payments.
      expect(reads).toEqual(["2025-10-01T00:00:00.000Z"]);
      expect(texts.at(-1)).toMatch(/· dividends 3\.1 in: VUSA 3\.1/);
      expect(await runAt("2026-10-11T08:00:00Z")).toEqual([]);

      // No digest for two days: the next names what came in meanwhile.
      paid("d2", 1, "2026-10-12T20:00:00Z");
      expect(await runAt("2026-10-14T07:00:00Z")).toEqual(["demo"]);
      expect(texts.at(-1)).toMatch(/· dividends 1 in: VUSA 1(?: ·|$)/);

      // A read that fails leaves dividends out, and the next digest names what it missed.
      paid("d3", 2, "2026-10-14T15:00:00Z");
      fail = true;
      expect(await runAt("2026-10-15T07:00:00Z")).toEqual(["demo"]);
      expect(texts.at(-1)).not.toMatch(/dividends/);
      fail = false;
      expect(await runAt("2026-10-16T07:00:00Z")).toEqual(["demo"]);
      expect(texts.at(-1)).toMatch(/· dividends 2 in: VUSA 2(?: ·|$)/);

      // One dated before the last digest that reached the history only after it.
      paid("d4", 0.5, "2026-10-16T06:00:00Z");
      expect(await runAt("2026-10-17T07:00:00Z")).toEqual(["demo"]);
      expect(texts.at(-1)).toMatch(/· dividends 0\.5 in: VUSA 0\.5(?: ·|$)/);

      // Each is named once.
      expect(await runAt("2026-10-18T07:00:00Z")).toEqual(["demo"]);
      expect(texts.at(-1)).not.toMatch(/dividends [\d.]+ in/);
      expect(texts).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names holdings a stop does not fully cover, once any stop is in place", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    expect(await services.digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[0]).not.toMatch(/stop-loss/);
    services.orders.list = [{ id: 7, ticker: "VUSA_EQ", type: "STOP", side: "SELL", quantity: -4, stopPrice: 90, status: "NEW" }];
    expect(await services.digest.run(new Date("2026-10-12T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[1]).toMatch(/· no full stop-loss: VUSA_EQ$/);
  });

  it("counts the fills the order watch saw in the last day", async () => {
    const services = setup({ DIGEST_HOUR_UTC: "7" });
    // Kept apart from the activity log, which keeps only its newest events.
    await services.store.put("order-fills:demo", ["2026-10-10T06:00:00Z", "2026-10-10T08:00:00Z", "2026-10-11T01:00:00Z"]);
    await services.store.put("order-fills:live", ["2026-10-11T03:00:00Z"]);
    expect(await services.digest.run(new Date("2026-10-11T07:00:00Z"))).toEqual(["demo"]);
    expect(services.hooks[0]).toMatch(/· 2 order\(s\) filled in the last day/);
  });

  it("sends once per day at the configured hour and reports the change since the last one", async () => {
    // The store expires the day's claim against the clock, so the clock moves with the scheduler here.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7" });
      const runAt = (time: string) => { vi.setSystemTime(new Date(time)); return services.digest.run(new Date()); };
      expect(await runAt("2026-10-11T06:59:00Z")).toEqual([]);
      expect(await runAt("2026-10-11T07:00:00Z")).toEqual(["demo"]);
      expect(await runAt("2026-10-11T08:00:00Z")).toEqual([]);
      services.total.value = 2050;
      expect(await runAt("2026-10-12T07:01:00Z")).toEqual(["demo"]);
      expect(services.hooks).toHaveLength(2);
      expect(services.hooks[0]).toMatch(/^\[TradePilot DEMO\] Daily digest · Total 2000 EUR · cash 1000 · unrealized \+100 · top: VUSA_EQ 1000 \(\+100\)/);
      expect(services.hooks[1]).toMatch(/\+50 since the last digest/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed digest every 15 minutes for the rest of the day", async () => {
    // The store expires keys against the clock, so the clock moves with the scheduler here.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7" });
      const runAt = (time: string) => { vi.setSystemTime(new Date(`2026-10-11T${time}:00Z`)); return services.digest.run(new Date()); };
      services.outage.on = true;
      expect(await runAt("07:00")).toEqual([]);
      services.outage.on = false;
      expect(await runAt("07:05")).toEqual([]);
      expect(await runAt("07:16")).toEqual(["demo"]);
      expect(await runAt("07:40")).toEqual([]);
      expect(services.hooks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a day as sent only once the webhook accepts it, whatever NOTIFY_EVENTS lists", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const services = setup({ DIGEST_HOUR_UTC: "7", NOTIFY_EVENTS: "order_submitted" });
      const runAt = (time: string) => { vi.setSystemTime(new Date(`2026-10-11T${time}:00Z`)); return services.digest.run(new Date()); };
      services.hookDown.on = true;
      expect(await runAt("07:00")).toEqual([]);
      services.hookDown.on = false;
      expect(await runAt("07:16")).toEqual(["demo"]);
      expect(services.hooks).toHaveLength(1);
      expect((await services.trading.getActivity("demo")).filter((event) => event.type === "daily_digest")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is off without an hour or a webhook", async () => {
    expect(await setup({}).digest.run(new Date("2026-10-11T12:00:00Z"))).toEqual([]);
    expect(() => createConfig({ DIGEST_HOUR_UTC: "25" })).toThrow(/DIGEST_HOUR_UTC/);
  });
});
