import { describe, expect, it } from "vitest";
import type { HistoryOrderItem } from "./history.js";
import { adjustCloses, chartFactor, closesAdjusted, restateSplits, splitFactor } from "./splits.js";

const fill = (ticker: string, side: "BUY" | "SELL", quantity: number, price: number, filledAt: string, type?: string): HistoryOrderItem => ({
  order: { ticker, side },
  fill: { filledAt, quantity: side === "SELL" ? -quantity : quantity, price, ...(type ? { type } : {}) },
});

describe("splits", () => {
  it("restate the fills before a split listed as the old shares closed and the new opened, and leave out its own", () => {
    const buy = fill("NVDA", "BUY", 10, 1000, "2024-05-01T14:00:00Z");
    const items = [
      fill("NVDA", "BUY", 5, 120, "2024-07-01T14:00:00Z"),
      fill("NVDA", "BUY", 100, 100, "2024-06-10T08:00:00Z", "STOCK_SPLIT"),
      fill("NVDA", "SELL", 10, 1000, "2024-06-10T08:00:00Z", "STOCK_SPLIT"),
      buy,
      fill("AAPL", "BUY", 1, 200, "2024-05-01T14:00:00Z"),
    ];
    const restated = restateSplits(items);
    expect(restated.splits).toEqual([{ ticker: "NVDA", at: "2024-06-10T08:00:00.000Z", ratio: 10 }]);
    expect(restated.unresolved.size).toBe(0);
    // Newest first as read, the split's fills gone, the buy before it in today's shares at today's price.
    expect(restated.items.map((item) => [item.order?.ticker, item.fill?.quantity, item.fill?.price])).toEqual([["NVDA", 5, 120], ["NVDA", 100, 100], ["AAPL", 1, 200]]);
    expect(buy.fill).toEqual({ filledAt: "2024-05-01T14:00:00Z", quantity: 10, price: 1000 });
  });

  it("tell a split listed as the shares added alone from the shares held now, or from the fills when the history starts with them", () => {
    const items = [
      fill("X", "SELL", 4, 50, "2024-08-01T14:00:00Z"),
      fill("X", "BUY", 30, 0, "2024-06-10T08:00:00Z", "STOCK_SPLIT"),
      fill("X", "BUY", 10, 150, "2024-05-01T14:00:00Z"),
    ];
    // Held now: 36. Before the sale 40, before the split 10: 4 for 1.
    expect(restateSplits(items, undefined, { held: () => 36 }).splits.map((split) => split.ratio)).toEqual([4]);
    expect(restateSplits(items, undefined, { fromStart: true }).splits.map((split) => split.ratio)).toEqual([4]);
    // Not read from the first buy, the fills cannot tell.
    expect(restateSplits(items).unresolved).toEqual(new Set(["X"]));
    // The first buy before the history read: the fills say 0 before the split, and only the holding tells.
    const later = items.slice(0, 2);
    expect(restateSplits(later, undefined, { fromStart: true }).unresolved).toEqual(new Set(["X"]));
    expect(restateSplits(later).items).toHaveLength(2);
    expect(restateSplits(later, undefined, { held: () => 36 }).splits.map((split) => split.ratio)).toEqual([4]);
  });

  it("restate a consolidation, and fills before two splits by both", () => {
    const items = [
      fill("Y", "BUY", 2, 10, "2024-09-01T14:00:00Z", "STOCK_SPLIT"),
      fill("Y", "SELL", 20, 1, "2024-09-01T14:00:00Z", "STOCK_SPLIT"),
      fill("Y", "BUY", 10, 2, "2024-06-01T14:00:00Z", "STOCK_SPLIT"),
      fill("Y", "SELL", 5, 4, "2024-06-01T14:00:00Z", "STOCK_SPLIT"),
      fill("Y", "BUY", 5, 4, "2024-05-01T14:00:00Z"),
    ];
    const restated = restateSplits(items);
    expect(restated.splits.map((split) => split.ratio)).toEqual([2, 0.1]);
    expect(restated.items.map((item) => [item.fill?.quantity, item.fill?.price])).toEqual([[1, 20]]);
    expect(splitFactor(restated.splits, Date.parse("2024-05-01"))).toBeCloseTo(0.2);
    expect(splitFactor(restated.splits, Date.parse("2024-07-01"))).toBeCloseTo(0.1);
    expect(splitFactor(restated.splits, Date.parse("2024-10-01"))).toBe(1);
  });

  it("group an instrument's tickers, so a split read under one restates the other's fills", () => {
    const items = [
      fill("SHEL_EQ", "BUY", 20, 0, "2024-06-10T08:00:00Z", "STOCK_SPLIT"),
      fill("SHEL_L_EQ", "BUY", 10, 30, "2024-05-01T14:00:00Z"),
    ];
    const restated = restateSplits(items, () => "isin:GB00", { held: () => 30 });
    expect(restated.items.map((item) => item.fill?.quantity)).toEqual([30]);
  });

  it("take a pair broken by a trade as one split, the trade after it, and leave a one-sided split with a trade among its fills", () => {
    const pair = [
      fill("P", "BUY", 20, 5, "2024-06-10T15:00:00Z", "STOCK_SPLIT"),
      fill("P", "BUY", 2, 5, "2024-06-10T14:00:00Z"),
      fill("P", "SELL", 10, 10, "2024-06-10T05:00:00Z", "STOCK_SPLIT"),
      fill("P", "BUY", 10, 10, "2024-05-01T14:00:00Z"),
    ];
    const restated = restateSplits(pair, undefined, { held: () => 22 });
    expect(restated.splits.map((split) => split.ratio)).toEqual([2]);
    expect(restated.items.map((item) => [item.fill?.quantity, item.fill?.price])).toEqual([[2, 5], [20, 5]]);
    const oneSided = [
      fill("Q", "BUY", 20, 0, "2024-06-10T15:00:00Z", "STOCK_SPLIT"),
      fill("Q", "BUY", 2, 5, "2024-06-10T14:00:00Z"),
      fill("Q", "BUY", 3, 0, "2024-06-10T05:00:00Z", "STOCK_SPLIT"),
      fill("Q", "BUY", 10, 10, "2024-05-01T14:00:00Z"),
    ];
    expect(restateSplits(oneSided, undefined, { held: () => 35 }).unresolved).toEqual(new Set(["Q"]));
  });

  it("tell closes adjusted for a split from those that are not", () => {
    const split = { at: "2024-06-10T08:00:00.000Z", ratio: 10 };
    const adjusted = [{ date: "2024-06-07", close: 120 }, { date: "2024-06-10", close: 121 }];
    const raw = [{ date: "2024-06-07", close: 1200 }, { date: "2024-06-10", close: 121 }];
    expect(closesAdjusted(adjusted, split)).toBe(true);
    expect(closesAdjusted(raw, split)).toBe(false);
    expect(closesAdjusted(raw.slice(1), split)).toBe(true);
    expect(adjustCloses(raw, [split])).toEqual(adjusted);
    expect(adjustCloses(adjusted, [split])).toEqual(adjusted);
    expect(chartFactor([split], adjusted, Date.parse("2024-06-01"))).toBe(10);
    expect(chartFactor([split], raw, Date.parse("2024-06-01"))).toBe(1);
    // A 3-for-2 split on closes adjusted for it, on a day that fell a fifth: a move, not the split.
    const threeForTwo = { at: "2024-06-10T08:00:00.000Z", ratio: 1.5 };
    expect(closesAdjusted([{ date: "2024-06-07", close: 100 }, { date: "2024-06-10", close: 80 }], threeForTwo)).toBe(true);
    expect(closesAdjusted([{ date: "2024-06-07", close: 150 }, { date: "2024-06-10", close: 101 }], threeForTwo)).toBe(false);
    // Stamped the evening before its first day: the gap into the next day is the split's.
    const evening = { at: "2024-06-09T22:00:00.000Z", ratio: 10 };
    expect(closesAdjusted([{ date: "2024-06-07", close: 1200 }, { date: "2024-06-10", close: 121 }], evening)).toBe(false);
    // A 5-for-4 is within a day's move: taken as adjusted.
    expect(closesAdjusted([{ date: "2024-06-07", close: 125 }, { date: "2024-06-10", close: 100 }], { at: "2024-06-10T08:00:00.000Z", ratio: 1.25 })).toBe(true);
  });
});
