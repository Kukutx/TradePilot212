import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { holdingPositionHistory } from "../shared/position-history.js";
import { holdingDetail } from "./holding.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
}

describe("holding detail", () => {
  it("gathers a holding's position, orders, alerts, target and the last year of fills and dividends", async () => {
    const services = sample();
    await services.alerts.create({ environment: "demo", instrument: "NVDA_US_EQ", condition: "below", price: 110 });
    await services.alerts.create({ environment: "demo", instrument: "AAPL_US_EQ", condition: "above", price: 260 });
    await services.targets.set("demo", { targets: [{ instrument: "NVDA_US_EQ", weight: 0.15 }] });
    const detail = await holdingDetail(services, "demo", "NVDA");
    expect(detail).toMatchObject({ kind: "holding", ticker: "NVDA_US_EQ", accountCurrency: "EUR", targetWeight: 0.15, instrument: { name: "NVIDIA", currencyCode: "USD" } });
    expect(detail.position?.quantity).toBe(20);
    expect(detail.weight).toBeGreaterThan(0.1);
    expect(detail.weight).toBeLessThan(0.2);
    expect(detail.orders.map((order) => order.id)).toEqual([81235]);
    expect(detail.alerts.map((alert) => alert.ticker)).toEqual(["NVDA_US_EQ"]);
    expect(detail.history?.fills.length).toBeGreaterThan(0);
    expect(detail.history?.fills.every((fill) => fill.filledAt && Date.parse(fill.filledAt) >= Date.parse(detail.history!.from))).toBe(true);
    const text = describePayload(detail);
    expect(text).toMatch(/^NVDA_US_EQ \(NVIDIA\) on DEMO, STOCK in USD/m);
    expect(text).toMatch(/Holding: NVDA_US_EQ NVIDIA: 20 @ 128\.75 USD .* of the account \(target 15%\)\./);
    expect(text).toMatch(/#81235 SELL 5 NVDA_US_EQ \(NVIDIA\) stop 118, 8\.3% below the last price 128\.75/);
    expect(text).toMatch(/NVDA_US_EQ \(NVIDIA\) below 110 USD/);
  });

  it("gives a holding's move on the day, and the change alone of one not held", async () => {
    const held = await holdingDetail(sample(), "demo", "NVDA");
    const day = held.day!;
    expect(day.previousClose?.source).toBe("sample");
    expect(day.change).toBeCloseTo(128.75 / day.previousClose!.close - 1, 6);
    expect(day.profitLoss).toBeDefined();
    expect(describePayload(held)).toMatch(/^On the day \(\d{4}-\d{2}-\d{2}\): [+-][\d.]+% since the close on \d{4}-\d{2}-\d{2} \([\d.]+ USD\), [+-][\d.]+ EUR/m);
    const late = describePayload({ ...held, day: { ...day, change: undefined, profitLoss: undefined, missing: "lag", problem: "stooq's closes for NVDA.US end on 2026-10-07, before the last session (2026-10-08); the day's move shows once they have it." } });
    expect(late).toMatch(/^On the day \(\d{4}-\d{2}-\d{2}\): no move for the day; stooq's closes for NVDA\.US end on 2026-10-07, before the last session \(2026-10-08\); the day's move shows once they have it\.$/m);
    const tesla = await holdingDetail(sample(), "demo", "Tesla");
    expect(tesla.day).toMatchObject({ quantity: 0, price: 244.1 });
    expect(tesla.day!.change).toBeCloseTo(244.1 / tesla.day!.previousClose!.close - 1, 6);
    expect(tesla.day!.profitLoss).toBeUndefined();
  });

  it("sets a quoted price against the last session before the open, as a quote does not move then", async () => {
    const services = sample();
    // NASDAQ with a pre-market from 08:00 UTC: Monday 12 October 2026 at 09:00 is in it.
    const week = [5, 6, 7, 8, 9, 12, 13].flatMap((date) => {
      const at = (hours: number) => new Date(Date.UTC(2026, 9, date) + hours * 3_600_000).toISOString();
      return [{ date: at(8), type: "PRE_MARKET_OPEN" }, { date: at(13.5), type: "OPEN" }, { date: at(20), type: "CLOSE" }];
    });
    const insights = Object.create(services.insights) as typeof services.insights;
    insights.schedules = async () => [{ id: 1, name: "NASDAQ", workingSchedules: [{ id: 1, timeEvents: week as never }] }];
    const monday = new Date("2026-10-12T09:00:00Z");
    const tesla = await holdingDetail({ ...services, insights }, "demo", "Tesla", monday);
    expect(tesla.day?.day).toBe("2026-10-09");
    // Trading 212's own price of a holding traded in the pre-market belongs to the coming day.
    const nvidia = await holdingDetail({ ...services, insights }, "demo", "NVDA_US_EQ", monday);
    expect(nvidia.day?.day).toBe("2026-10-12");
    expect(nvidia.market).toMatchObject({ scheduleId: 1, session: "pre_market" });
  });

  it("finds a holding's exchange in the instrument list, as Trading 212's holdings do not name it", async () => {
    const services = sample();
    const trading = Object.create(services.trading) as typeof services.trading;
    trading.getDashboard = async (environment, maxAgeMs) => {
      const dashboard = await services.trading.getDashboard(environment, maxAgeMs);
      return { ...dashboard, positions: dashboard.positions.map(({ instrument, ...position }) => ({ ...position, instrument: { ticker: instrument.ticker, name: instrument.name, currencyCode: instrument.currencyCode } as typeof instrument })) };
    };
    // Opened from the holdings, by its exact ticker.
    const detail = await holdingDetail({ ...services, trading }, "demo", "NVDA_US_EQ");
    expect(detail.market?.session).not.toBe("unknown");
    expect(detail.market?.scheduleId).toBe(1);
  });

  it("totals a year of dividends and lists the newest", async () => {
    const detail = await holdingDetail(sample(), "demo", "AAPL_US_EQ");
    // The sample pays Apple four quarterly dividends in the last year.
    expect(detail.history?.dividendCount).toBe(4);
    expect(detail.history?.dividends).toHaveLength(4);
    expect(detail.history?.dividendTotal).toBeCloseTo(detail.history!.dividends.reduce((sum, item) => sum + item.amount, 0), 2);
    expect(describePayload(detail)).toMatch(/Dividends since \d{4}-\d{2}-\d{2}: [\d.]+ EUR from 4 payment\(s\), last [\d.]+ EUR on \d{4}-\d{2}-\d{2}\./);
    // A quarter on from the last payment, four times, at today's quantity.
    const quantity = detail.position!.quantity;
    const perShare = detail.history!.dividends[0]!.amount / detail.history!.dividends[0]!.quantity!;
    expect(detail.history?.dividendFrequency).toBe(4);
    expect(detail.history?.dividendsFrom?.slice(8, 19)).toBe("01T00:00:00");
    expect(detail.history?.nextDividends).toHaveLength(4);
    expect(detail.history!.nextDividends![0]!.on > detail.history!.dividends[0]!.date.slice(0, 10)).toBe(true);
    for (const payment of detail.history!.nextDividends!) expect(payment.amount).toBeCloseTo(perShare * quantity, 2);
    expect(describePayload(detail)).toMatch(/Expected next dividends \(quarterly\), at today's quantity, dates approximate: about \d{4}-\d{2}-\d{2} [\d.]+ EUR; /);
  });

  it("shows an instrument that is not held, with its open orders", async () => {
    const detail = await holdingDetail(sample(), "demo", "Tesla");
    expect(detail.ticker).toBe("TSLA_US_EQ");
    expect(detail.position).toBeUndefined();
    expect(detail.weight).toBeUndefined();
    expect(detail.orders.map((order) => order.id)).toEqual([81234]);
    // Not held, its price comes from the quote provider: the sample account's own, offline.
    expect(detail.quote).toMatchObject({ price: 244.1, source: "sample", symbol: "TSLA" });
    expect(describePayload(detail)).toMatch(/^Not held; price 244\.1 USD \(simulated for the sample account\)\.$/m);
    // And the simulated closes end at that price.
    expect(detail.prices?.points.at(-1)?.close).toBe(244.1);
  });

  it("leaves the quote out of a holding's page, and says so when the provider gives none", async () => {
    const held = await holdingDetail(sample(), "demo", "NVDA");
    expect(held.quote).toBeUndefined();
    const services = sample();
    const quiet = { ...services, trading: Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, { externalQuote: async () => undefined }) };
    const detail = await holdingDetail(quiet, "demo", "TSLA");
    expect(detail.quote).toBeUndefined();
    expect(detail).toMatchObject({ pricesMissing: "sample" });
    expect(describePayload(detail)).toMatch(/^Not held\.$/m);
  });

  it("adds a year of daily closes that pass through the fills, and sums them up in the text", async () => {
    const detail = await holdingDetail(sample(), "demo", "NVDA_US_EQ");
    const points = detail.prices!.points;
    expect(detail.prices?.source).toBe("sample");
    expect(points.length).toBeGreaterThan(250);
    expect(points.at(-1)?.close).toBe(128.75);
    for (const fill of detail.history!.fills) {
      const day = points.filter((point) => point.date <= fill.filledAt!.slice(0, 10)).at(-1);
      expect(day?.close).toBeCloseTo(fill.price!, 2);
    }
    expect(describePayload(detail)).toMatch(/^Daily closes \(simulated for the sample account\) \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}: [\d.]+ to 128\.75 USD \([+-][\d.]+%\); 1M [+-][\d.]+%, 3M [+-][\d.]+%, 6M [+-][\d.]+%; high [\d.]+ on \d{4}-\d{2}-\d{2}, low [\d.]+ on \d{4}-\d{2}-\d{2}\.$/m);
  });

  it("draws the position over the closes beside what it would be had the price not moved, and says it in the text", async () => {
    const detail = await holdingDetail(sample(), "demo", "NVDA_US_EQ");
    const history = holdingPositionHistory(detail);
    if (!history || typeof history !== "object") throw new Error(`no position history: ${history}`);
    // Today's 20 shares at the last close, at Trading 212's own valuation's rate.
    const last = history.days.at(-1)!;
    expect(last.shares).toBe(20);
    expect(last.value).toBeCloseTo((detail.position!.walletImpact as { currentValue: number }).currentValue, 0);
    // The sample's NVDA fills are buys and sells of 2 or 3 shares, so the shares at the first close are fewer or more.
    expect(history.days[0]!.shares).toBe(history.startShares);
    expect(history.gain).toBeCloseTo(last.value - last.base, 2);
    expect(describePayload(detail)).toMatch(/^Position from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} at the closes, at today's exchange rate: value [\d.]+ EUR against [\d.]+ EUR had the price not moved \([\d.]+ shares at the first close, plus buys less sells at their prices\), so the price (added|took) [\d.]+ EUR\.$/m);
  });

  it("lists the newest 20 fills and gives the chart the older ones with only what a mark needs", async () => {
    const services = sample();
    const trades = services.insights.tradeHistory.bind(services.insights);
    services.insights.tradeHistory = async (...args) => {
      const read = await trades(...args);
      const one = read.fills[0]!;
      const fills = Array.from({ length: 26 }, (_, index) => ({ ...one, orderId: String(500 + index), filledAt: new Date(Date.parse(one.filledAt!) - index * 7 * 86_400_000).toISOString(), quantity: index % 5 === 4 ? -1 : 1 }));
      return { ...read, fills };
    };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history?.fills).toHaveLength(20);
    expect(detail.history?.olderFills).toHaveLength(6);
    expect(detail.history?.olderFills?.[4]).toEqual({ filledAt: expect.any(String), side: "SELL", quantity: 1, price: expect.any(Number) });
    expect(describePayload(detail)).toMatch(/Fills since \d{4}-\d{2}-\d{2} \(newest 20 of 26\)/);
  });

  it("leaves out a quote in another unit, also when the closes did not come", async () => {
    // TSLA has a buy limit at 215; a quote a hundred times under it is in another unit.
    for (const read of [{ missing: "data" as const, problem: "Stooq took more than 3 seconds." }, { missing: "unit" as const, problem: "Stooq's closes look like another unit." }]) {
      const services = sample();
      const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, {
        externalQuote: async () => ({ ticker: "TSLA_US_EQ", symbol: "TSLA.US", price: 2.441, asOf: "2026-10-12T15:00:00Z", source: "stooq" }),
      });
      const detail = await holdingDetail({ ...services, trading, priceHistory: async () => read }, "demo", "TSLA");
      expect(detail.quote).toBeUndefined();
      expect(detail.pricesMissing).toBe("unit");
      expect(detail.pricesProblem).toBe(read.missing === "unit" ? read.problem
        : "stooq's price for TSLA.US (2.441) is far from Trading 212's order and alert prices (215), so it looks like another unit; multiply the factor in its QUOTE_SYMBOLS mapping by 100 (TSLA_US_EQ=TSLA.US*100 when it has none).");
    }
  });

  it("keeps the rest when the daily closes cannot be read", async () => {
    const services = { ...sample(), priceHistory: async () => { throw new Error("quote provider down"); } };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail).toMatchObject({ pricesMissing: "data", pricesProblem: "quote provider down" });
    expect(detail.history?.fills.length).toBeGreaterThan(0);
  });

  it("says which history ran out of pages, so a partial dividend total is not read as the year's", async () => {
    const services = sample();
    const cash = services.insights.cashHistory.bind(services.insights);
    services.insights.cashHistory = async (...args) => ({ ...(await cash(...args)), truncated: true });
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history).toMatchObject({ fillsTruncated: false, dividendsTruncated: true });
    const text = describePayload(detail);
    expect(text).toMatch(/older payments were not read, so the total covers only the newer part of the window\./);
    expect(text).not.toMatch(/Fills since .*more not read/);
  });

  it("shows the saved target of an instrument that is not held", async () => {
    const services = sample();
    await services.targets.set("demo", { targets: [{ instrument: "TSLA_US_EQ", weight: 0.05 }] });
    const detail = await holdingDetail(services, "demo", "TSLA_US_EQ");
    expect(detail.targetWeight).toBe(0.05);
    expect(describePayload(detail)).toMatch(/^Not held; price 244\.1 USD \(simulated for the sample account\); target 5%\.$/m);
  });

  it("keeps the rest when the history cannot be read", async () => {
    const services = sample();
    services.insights.tradeHistory = async () => { throw new Error("Trading 212 rate limit reached (429)"); };
    const detail = await holdingDetail(services, "demo", "AAPL_US_EQ");
    expect(detail.history).toBeUndefined();
    expect(detail.historyProblem).toMatch(/rate limit/);
    expect(detail.position?.quantity).toBe(12);
    expect(describePayload(detail)).toMatch(/History not read: .*rate limit/);
    // The day's move still shows, and says that the day's trades could not be counted from their price.
    expect(detail.day?.problem).toBe("The order history could not be read, so shares traded on the day count from the previous close.");
  });

  it("says when the account is not connected", async () => {
    const services = createServices({ config: createConfig({}), store: new MemoryStateStore() });
    await expect(holdingDetail(services, "demo", "AAPL_US_EQ")).rejects.toThrow(/credentials are not configured/);
  });
});
