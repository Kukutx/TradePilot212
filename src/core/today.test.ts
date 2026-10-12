import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import type { Exchange } from "../shared/history.js";
import type { PriceHistoryRequest } from "./price-history.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";
import { dayFigures, fallbackDay, portfolioToday, sessionOf, type ScheduleEvent } from "./today.js";

/** A US week as Trading 212 lists it: pre-market, the regular session and after hours, Monday 5 to Friday 16 October 2026. */
function usWeek(): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  for (let date = Date.UTC(2026, 9, 5); date <= Date.UTC(2026, 9, 16); date += 86_400_000) {
    const weekday = new Date(date).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const at = (hours: number) => new Date(date + hours * 3_600_000).toISOString();
    events.push({ date: at(8), type: "PRE_MARKET_OPEN" }, { date: at(13.5), type: "OPEN" }, { date: at(20), type: "CLOSE" }, { date: at(24), type: "AFTER_HOURS_CLOSE" });
  }
  return events;
}

describe("the trading day of a price", () => {
  const week = usWeek();
  const at = (iso: string) => sessionOf(week, new Date(iso));

  it("is the session in progress, or the one that closed last, after hours and over the weekend", () => {
    expect(at("2026-10-14T15:00:00Z")).toEqual({ day: "2026-10-14", previous: "2026-10-13" });
    expect(at("2026-10-14T22:00:00Z")).toEqual({ day: "2026-10-14", previous: "2026-10-13" });
    expect(at("2026-10-10T12:00:00Z")).toEqual({ day: "2026-10-09", previous: "2026-10-08" });
    // Monday before the pre-market still shows Friday's move.
    expect(at("2026-10-12T05:00:00Z")).toEqual({ day: "2026-10-09", previous: "2026-10-08" });
  });

  it("belongs to the day that opens next in the pre-market", () => {
    expect(at("2026-10-12T09:00:00Z")).toEqual({ day: "2026-10-12", previous: "2026-10-09" });
  });

  it("has no answer without an opening to go by, and then takes today or the Friday before a weekend", () => {
    expect(sessionOf(week, new Date("2026-10-01T12:00:00Z"))).toBeUndefined();
    expect(sessionOf(undefined, new Date("2026-10-14T12:00:00Z"))).toBeUndefined();
    expect(fallbackDay(new Date("2026-10-10T12:00:00Z"))).toBe("2026-10-09");
    expect(fallbackDay(new Date("2026-10-11T12:00:00Z"))).toBe("2026-10-09");
    expect(fallbackDay(new Date("2026-10-13T12:00:00Z"))).toBe("2026-10-13");
  });
});

describe("one holding's figures for the day", () => {
  it("counts the shares held at the previous close from it", () => {
    expect(dayFigures({ quantity: 10, price: 110, previous: 100, fills: [] })).toEqual({ change: 0.1, profitLoss: 100, base: 1000, bought: 0, sold: 0 });
  });

  it("counts the day's buys from their fill price and its sells to theirs", () => {
    const at = "2026-10-09T15:00:00Z";
    // 6 held at the close made 60; 4 bought at 105 made 20.
    expect(dayFigures({ quantity: 10, price: 110, previous: 100, fills: [{ ticker: "X", side: "buy", quantity: 4, price: 105, at }] }))
      .toEqual({ change: 0.1, profitLoss: 80, base: 1020, bought: 4, sold: 0 });
    // 5 still held made 50; 5 sold at 108 made 40.
    expect(dayFigures({ quantity: 5, price: 110, previous: 100, fills: [{ ticker: "X", side: "sell", quantity: 5, price: 108, at }] }))
      .toEqual({ change: 0.1, profitLoss: 90, base: 1000, bought: 0, sold: 5 });
    // Sold out: only the sells count, and there is no price to compare.
    expect(dayFigures({ quantity: 0, previous: 100, fills: [{ ticker: "X", side: "sell", quantity: 3, price: 95, at }] }))
      .toEqual({ profitLoss: -15, base: 300, bought: 0, sold: 3 });
  });
});

describe("the portfolio on the day", () => {
  const services = createServices({ config: createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
  // Each instrument closed 2% below its price now on Thursday 8 October, and at it on Friday.
  const priceHistory = async ({ instrument, last }: PriceHistoryRequest) => ({
    prices: { source: "stooq", symbol: instrument.shortName, points: [{ date: "2026-10-07", close: 1 }, { date: "2026-10-08", close: last! / 1.02 }, { date: "2026-10-09", close: last! }] },
  });
  const saturday = new Date("2026-10-10T12:00:00Z");
  const base = { trading: services.trading, priceHistory, schedules: async () => [] as Exchange[] };

  it("sets each holding against its last close before the day, in the account currency, biggest first", async () => {
    const today = await portfolioToday(base, "demo", saturday);
    expect(today.moves.map((move) => move.ticker).sort()).toEqual(["AAPL_US_EQ", "KO_US_EQ", "MSFT_US_EQ", "NVDA_US_EQ", "VUSAl_EQ"]);
    for (const move of today.moves) {
      expect(move.day).toBe("2026-10-09");
      expect(move.previousClose).toMatchObject({ date: "2026-10-08", source: "stooq" });
      expect(move.change).toBeCloseTo(0.02, 6);
    }
    const apple = today.moves.find((move) => move.ticker === "AAPL_US_EQ")!;
    // 12 shares, 4.54 dollars each, at 0.92 euro to the dollar.
    expect(apple.profitLoss).toBeCloseTo(12 * (231.55 - 231.55 / 1.02) * 0.92, 1);
    const vusa = today.moves.find((move) => move.ticker === "VUSAl_EQ")!;
    expect(vusa.profitLoss).toBeCloseTo(40 * (9175 - 9175 / 1.02) * 0.0118, 1);
    const sizes = today.moves.map((move) => Math.abs(move.profitLoss!));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(today.total).toMatchObject({ counted: 5, of: 5 });
    expect(today.total!.profitLoss).toBeCloseTo(today.moves.reduce((sum, move) => sum + move.profitLoss!, 0), 2);
    expect(today.total!.change).toBeCloseTo(0.02, 3);
    const text = describePayload(today);
    expect(text).toMatch(/^Holdings on the day \(2026-10-09\), against each one's last close before it: \+[\d.]+ EUR \(\+2(\.0)?%\), 5 of 5 instrument\(s\) with a move\.$/m);
    expect(text).toMatch(/^- Apple \(AAPL\): \+2(\.0)?% since the close on 2026-10-08 \(227\.0098\d* USD\), \+[\d.]+ EUR$/m);
  });

  it("counts the day's buys and sells from their fill price, an instrument sold out included", async () => {
    let asked: Date | undefined;
    const fills = async (_environment: string, from: Date) => {
      asked = from;
      return [
        { ticker: "AAPL_US_EQ", side: "BUY", quantity: 2, price: 230, filledAt: "2026-10-09T14:00:00Z" },
        { ticker: "MSFT_US_EQ", side: "SELL", quantity: -1, price: 430, filledAt: "2026-10-09T15:00:00Z" },
        { ticker: "TSLA_US_EQ", side: "SELL", quantity: 3, price: 240, filledAt: "2026-10-09T16:00:00Z" },
        // The day before does not count.
        { ticker: "KO_US_EQ", side: "BUY", quantity: 5, price: 60, filledAt: "2026-10-08T16:00:00Z" },
      ];
    };
    // Tesla closed at 250 on Thursday: Trading 212 no longer prices it, so the day's last fill checks the unit.
    const history = async (request: PriceHistoryRequest) => (request.instrument.ticker === "TSLA_US_EQ"
      ? { prices: { source: "stooq", points: [{ date: "2026-10-08", close: 250 }] } }
      : priceHistory(request));
    const today = await portfolioToday({ ...base, priceHistory: history, fills }, "demo", saturday);
    expect(asked?.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    const apple = today.moves.find((move) => move.ticker === "AAPL_US_EQ")!;
    const previous = 231.55 / 1.02;
    expect(apple.bought).toBe(2);
    expect(apple.profitLoss).toBeCloseTo((12 * (231.55 - previous) - 2 * (230 - previous)) * 0.92, 1);
    expect(today.moves.find((move) => move.ticker === "MSFT_US_EQ")).toMatchObject({ sold: 1 });
    expect(today.moves.find((move) => move.ticker === "KO_US_EQ")?.bought).toBeUndefined();
    const tesla = today.moves.find((move) => move.ticker === "TSLA_US_EQ")!;
    expect(tesla).toMatchObject({ quantity: 0, sold: 3, previousClose: { date: "2026-10-08", close: 250 } });
    expect(tesla.change).toBeUndefined();
    expect(tesla.profitLoss).toBeCloseTo(3 * (240 - 250) * 0.92, 2);
    expect(today.total).toMatchObject({ counted: 6, of: 6 });
    expect(describePayload(today)).toMatch(/^- Tesla \(TSLA\): sold out on the day against the close on 2026-10-08 \(250 USD\), -[\d.]+ EUR \(sold 3 on the day, from the fill price\)$/m);
  });

  it("still gives the moves when the day's fills cannot be read, and says so", async () => {
    const today = await portfolioToday({ ...base, fills: async () => { throw new Error("Trading 212 rate limit"); } }, "demo", saturday);
    expect(today.fillsProblem).toBe("Trading 212 rate limit");
    expect(today.total?.counted).toBe(5);
    expect(describePayload(today)).toContain("The day's fills could not be read (Trading 212 rate limit), so shares traded on the day count from the previous close.");
  });

  it("leaves a holding out when its closes lag the last session, or the read ran out of time", async () => {
    const schedules = async (): Promise<Exchange[]> => [1, 2].map((id) => ({ id, name: `Exchange ${id}`, workingSchedules: [{ id, timeEvents: usWeek() as never }] }));
    const stale = async ({ instrument, last }: PriceHistoryRequest) => (instrument.ticker === "KO_US_EQ"
      ? { prices: { source: "stooq", symbol: "KO.US", points: [{ date: "2026-10-06", close: 60 }, { date: "2026-10-07", close: 61 }] } }
      : priceHistory({ instrument, last, from: new Date() }));
    const today = await portfolioToday({ ...base, priceHistory: stale, schedules }, "demo", saturday);
    expect(today.moves.find((move) => move.ticker === "KO_US_EQ")).toMatchObject({
      missing: "lag", previousClose: { date: "2026-10-07" }, problem: "stooq's closes for KO.US end on 2026-10-07, before the last session (2026-10-08); the day's move shows once they have it.",
    });
    expect(today.total).toMatchObject({ counted: 4, of: 5 });
    const late = await portfolioToday({ ...base, budgetMs: -1 }, "demo", saturday);
    expect(late.moves.every((move) => move.missing === "later")).toBe(true);
    expect(late.total).toBeUndefined();
    expect(describePayload(late)).toMatch(/^No holding has a move for the day\.$/m);
  });

  it("draws the sample account's moves from its own simulated closes", async () => {
    const today = await services.today("demo");
    expect(today.moves.length).toBe(5);
    expect(today.moves.every((move) => move.previousClose?.source === "sample" && move.change !== undefined)).toBe(true);
  });
});
