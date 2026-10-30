import { describe, expect, it } from "vitest";
import type { HistoryOrderItem } from "../shared/history.js";
import { ukShareMatching } from "./uk-matching.js";

const fill = (ticker: string, side: "BUY" | "SELL", quantity: number, value: number | undefined, filledAt: string, extra: { realised?: number; isin?: string; type?: string } = {}): HistoryOrderItem => ({
  order: { ticker, side, ...(extra.isin ? { instrument: { ticker, isin: extra.isin } } : {}) },
  fill: {
    filledAt, quantity: side === "SELL" ? -quantity : quantity, ...(extra.type ? { type: extra.type } : {}),
    ...(value === undefined ? {} : { walletImpact: { netValue: side === "SELL" ? value : -value, ...(extra.realised === undefined ? {} : { realisedProfitLoss: extra.realised }) } }),
  },
});
// The 2025/26 UK tax year, read well after its last 30-day buys could still come in.
const year = { from: new Date("2025-04-05T23:00:00Z"), to: new Date("2026-04-05T22:59:59.999Z"), now: new Date("2026-06-01T00:00:00Z") };
const match = (orders: HistoryOrderItem[], extra: Partial<Parameters<typeof ukShareMatching>[0]> = {}) => ukShareMatching({ ...year, currency: "GBP", complete: true, orders, ...extra });

describe("UK share matching", () => {
  it("matches a sale with the same day's buys, then the next 30 days', then the pool at its average cost", () => {
    const result = match([
      fill("VOD_EQ", "BUY", 100, 1000, "2025-01-10T10:00:00Z"),
      fill("VOD_EQ", "BUY", 50, 600, "2025-05-01T10:00:00Z"),
      fill("VOD_EQ", "SELL", 60, 900, "2025-06-01T09:00:00Z", { realised: 200 }),
      fill("VOD_EQ", "BUY", 10, 140, "2025-06-01T14:00:00Z"),
      fill("VOD_EQ", "BUY", 20, 260, "2025-06-20T10:00:00Z"),
      // Bought 31 days after: not matched, it joins the pool.
      fill("VOD_EQ", "BUY", 5, 70, "2025-07-02T10:00:00Z"),
    ]);
    // Same day 10 for 140, 30 days 20 for 260, and 30 from a pool of 150 that cost 1,600: 320.
    expect(result.byTicker).toEqual([{ ticker: "VOD_EQ", disposals: 1, quantity: 60, proceeds: 900, cost: 720, gain: 180, sameDay: 10, thirtyDay: 20, pool: 30, unmatched: 0, realizedProfitLoss: 200 }]);
    expect(result).toMatchObject({ rule: "uk", complete: true, gains: 180, losses: 0, net: 180, realizedProfitLoss: 200 });
    expect(result.provisional).toBeUndefined();
  });

  it("counts days in UK time: a sale late in the London evening and a buy the next UTC morning are one day", () => {
    const result = match([
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "BUY", 5, 40, "2025-05-25T10:00:00Z"),
      // 23:30 UTC on 1 June is 00:30 on 2 June in London, the day of the next buy.
      fill("A", "SELL", 5, 75, "2025-06-01T23:30:00Z"),
      fill("A", "BUY", 5, 90, "2025-06-02T08:00:00Z"),
    ]);
    expect(result.byTicker[0]).toMatchObject({ sameDay: 5, thirtyDay: 0, pool: 0, cost: 90, gain: -15 });
  });

  it("matches the same day before an earlier sale's 30 days, and one day's sales and buys as one", () => {
    const sameDayFirst = match([
      fill("A", "BUY", 20, 200, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 10, 150, "2025-06-01T10:00:00Z"),
      fill("A", "BUY", 10, 120, "2025-06-05T10:00:00Z"),
      fill("A", "SELL", 10, 130, "2025-06-05T15:00:00Z"),
    ]);
    expect(sameDayFirst.byTicker[0]).toMatchObject({ sameDay: 10, thirtyDay: 0, pool: 10, cost: 220, gain: 60 });
    const oneDay = match([
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 5, 60, "2025-06-01T09:00:00Z"),
      fill("A", "SELL", 5, 70, "2025-06-01T10:00:00Z"),
      fill("A", "BUY", 4, 48, "2025-06-01T11:00:00Z"),
      fill("A", "BUY", 4, 52, "2025-06-01T12:00:00Z"),
    ]);
    expect(oneDay.byTicker[0]).toMatchObject({ disposals: 2, sameDay: 8, pool: 2, proceeds: 130, cost: 120, gain: 10 });
  });

  it("gives the 30-day buys to the earlier sale, leaves them out of the pool for a sale in between, and ends the 30 days at UK midnight", () => {
    const between = match([
      fill("A", "BUY", 100, 1000, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 50, 1000, "2025-06-01T10:00:00Z"),
      fill("A", "SELL", 20, 400, "2025-06-10T10:00:00Z"),
      fill("A", "BUY", 50, 750, "2025-06-20T10:00:00Z"),
    ]);
    expect(between.byTicker[0]).toMatchObject({ thirtyDay: 50, pool: 20, cost: 950, gain: 450 });
    const boundary = match([
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 10, 200, "2025-06-01T10:00:00Z"),
      // 23:30 on 1 July in London is day 30; 00:30 on 2 July is day 31, for the pool.
      fill("A", "BUY", 3, 60, "2025-07-01T22:30:00Z"),
      fill("A", "BUY", 3, 60, "2025-07-01T23:30:00Z"),
    ]);
    expect(boundary.byTicker[0]).toMatchObject({ thirtyDay: 3, pool: 7, cost: 130, gain: 70 });
  });

  it("keeps a buy matched with last year's sale out of this year's pool, and matches a sale on 5 April with buys after the year", () => {
    const lastYear = match([
      fill("A", "BUY", 10, 100, "2025-01-01T10:00:00Z"),
      fill("A", "SELL", 10, 150, "2025-04-05T10:00:00Z"),
      fill("A", "BUY", 10, 120, "2025-04-20T10:00:00Z"),
      fill("A", "SELL", 10, 130, "2025-06-01T10:00:00Z"),
    ]);
    expect(lastYear.byTicker[0]).toMatchObject({ quantity: 10, pool: 10, cost: 100, gain: 30 });
    const orders = [
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 10, 110, "2026-04-05T12:00:00Z"),
      fill("A", "BUY", 10, 100, "2026-04-20T10:00:00Z"),
    ];
    expect(match(orders).byTicker[0]).toMatchObject({ thirtyDay: 10, cost: 100, gain: 10 });
    // Read before those 30 days are past, it can still change.
    const early = match(orders, { now: new Date("2026-04-21T00:00:00Z") });
    expect(early.provisional).toBe(true);
    expect(early.notes.join(" ")).toMatch(/can still change/);
  });

  it("keeps gains and losses apart per disposal, not per instrument", () => {
    const result = match([
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 5, 100, "2025-06-01T10:00:00Z"),
      fill("A", "SELL", 5, 20, "2025-07-01T10:00:00Z"),
    ]);
    expect(result).toMatchObject({ gains: 50, losses: -30, net: 20 });
    expect(result.byTicker[0]).toMatchObject({ gain: 20 });
  });

  it("matches one ISIN under two tickers as one pool, and gives quantities to eight places", () => {
    const result = match([
      fill("VUSAl_EQ", "BUY", 0.1, 10, "2025-05-01T10:00:00Z", { isin: "IE00B3XXRP09" }),
      fill("VUSA_EQ", "BUY", 0.2, 20, "2025-05-02T10:00:00Z", { isin: "IE00B3XXRP09" }),
      fill("VUSAl_EQ", "SELL", 0.3, 36, "2025-06-01T10:00:00Z", { isin: "IE00B3XXRP09" }),
    ]);
    expect(result.byTicker).toHaveLength(1);
    expect(result.byTicker[0]).toMatchObject({ quantity: 0.3, pool: 0.3, cost: 30, gain: 6 });
  });

  it("checks what the fills add up to against the shares held, and flags fills that were not trades", () => {
    const orders = [
      fill("A", "BUY", 10, 100, "2025-05-01T10:00:00Z"),
      fill("A", "SELL", 4, 60, "2025-06-01T10:00:00Z"),
    ];
    expect(match(orders, { holdings: [{ ticker: "A", quantity: 6 }] }).complete).toBe(true);
    // A holding that gives the ISIN the fills leave out is the same instrument.
    expect(match(orders, { holdings: [{ ticker: "A", isin: "GB0000000001", quantity: 6 }] }).complete).toBe(true);
    // 10 more held than the fills add up to: transferred in, and the sale may have been of those.
    const off = match(orders, { holdings: [{ ticker: "A", quantity: 16 }] });
    expect(off.complete).toBe(false);
    expect(off.byTicker[0]).toMatchObject({ reconciliation: { held: 16, fills: 6 } });
    expect(off.notes.join(" ")).toMatch(/do not add up to the shares held now/);
    const split = match([...orders, fill("A", "BUY", 6, 0, "2025-07-01T10:00:00Z", { type: "STOCK_SPLIT" })], { holdings: [{ ticker: "A", quantity: 12 }] });
    expect(split.complete).toBe(false);
    expect(split.byTicker[0]).toMatchObject({ notTrades: 1 });
    expect(split.byTicker[0]!.reconciliation).toBeUndefined();
  });

  it("leaves out sales outside the year, and says what it could not match or value", () => {
    const result = match([
      fill("OLD", "BUY", 10, 100, "2024-05-01T10:00:00Z"),
      fill("OLD", "SELL", 10, 150, "2025-03-01T10:00:00Z"),
      fill("GONE", "SELL", 4, 40, "2025-06-01T10:00:00Z"),
      fill("FREE", "BUY", 2, undefined, "2025-04-20T10:00:00Z"),
      fill("FREE", "SELL", 2, 30, "2025-06-01T10:00:00Z"),
    ], { currency: "EUR", complete: false });
    expect(result.byTicker.map((row) => row.ticker).sort()).toEqual(["FREE", "GONE"]);
    expect(result.byTicker.find((row) => row.ticker === "GONE")).toMatchObject({ unmatched: 4, proceeds: 0, cost: 0, gain: 0 });
    expect(result.byTicker.find((row) => row.ticker === "FREE")).toMatchObject({ pool: 2, gain: 0, unvalued: true });
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/in EUR, not GBP.*could not be matched.*no account-currency value.*not read back to the first purchase/);
  });
});
