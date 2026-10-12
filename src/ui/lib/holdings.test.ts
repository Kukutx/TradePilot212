import { describe, expect, it } from "vitest";
import type { Position } from "../../shared/contracts";
import type { DayMove } from "../../shared/today";
import { holdingReturn, nextSort, readHoldingsPrefs, SORT_CHOICES, sortFromId, sortHoldings, sortId } from "./holdings";

const holding = (ticker: string, name: string, value?: number, result?: number): Position => ({
  instrument: { ticker, name, currencyCode: "USD" }, quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 1, currentPrice: 1,
  walletImpact: { ...(value === undefined ? {} : { currentValue: value }), ...(result === undefined ? {} : { unrealizedProfitLoss: result }) },
} as Position);
const apple = holding("AAPL_US_EQ", "Apple", 2556.31, 697.17);
const coke = holding("KO_US_EQ", "Coca-Cola", 1407.6, -85.1);
const nvidia = holding("NVDA_US_EQ", "NVIDIA", 2369, 597.08);
const fund = holding("VUSAl_EQ", "Vanguard S&P 500", undefined, undefined);
const positions = [apple, coke, nvidia, fund];
const moves = new Map<string, DayMove>([
  ["AAPL_US_EQ", { ticker: "AAPL_US_EQ", quantity: 1, day: "2026-10-09", change: 0.0393 }],
  ["KO_US_EQ", { ticker: "KO_US_EQ", quantity: 1, day: "2026-10-09", change: -0.0194 }],
  ["NVDA_US_EQ", { ticker: "NVDA_US_EQ", quantity: 1, day: "2026-10-09", missing: "lag" }],
]);
const tickers = (list: Position[]) => list.map((position) => position.instrument.ticker);

describe("holdings order", () => {
  it("keeps Trading 212's order unless asked, and sorts by value, the day, the result or the name", () => {
    expect(sortHoldings(positions, undefined, moves)).toBe(positions);
    expect(tickers(sortHoldings(positions, { key: "value", direction: "desc" }, moves))).toEqual(["AAPL_US_EQ", "NVDA_US_EQ", "KO_US_EQ", "VUSAl_EQ"]);
    expect(tickers(sortHoldings(positions, { key: "value", direction: "asc" }, moves))).toEqual(["KO_US_EQ", "NVDA_US_EQ", "AAPL_US_EQ", "VUSAl_EQ"]);
    // One without the figure goes last either way, in Trading 212's order.
    expect(tickers(sortHoldings(positions, { key: "day", direction: "asc" }, moves))).toEqual(["KO_US_EQ", "AAPL_US_EQ", "NVDA_US_EQ", "VUSAl_EQ"]);
    expect(tickers(sortHoldings(positions, { key: "pnl", direction: "desc" }, moves))).toEqual(["AAPL_US_EQ", "NVDA_US_EQ", "KO_US_EQ", "VUSAl_EQ"]);
    expect(tickers(sortHoldings(positions, { key: "name", direction: "asc" }, moves))).toEqual(["AAPL_US_EQ", "KO_US_EQ", "NVDA_US_EQ", "VUSAl_EQ"]);
  });

  it("cycles a number column from largest first to smallest first to Trading 212's order, and the name from A to Z and back", () => {
    expect(nextSort(undefined, "value")).toEqual({ key: "value", direction: "desc" });
    expect(nextSort({ key: "value", direction: "desc" }, "value")).toEqual({ key: "value", direction: "asc" });
    expect(nextSort({ key: "value", direction: "asc" }, "value")).toBeUndefined();
    expect(nextSort({ key: "value", direction: "asc" }, "day")).toEqual({ key: "day", direction: "desc" });
    expect(nextSort(undefined, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toBeUndefined();
    // Every order a header reaches is one the menu offers.
    for (const choice of SORT_CHOICES) expect(sortFromId(sortId(choice))).toEqual(choice);
    expect(sortFromId("default")).toBeUndefined();
    expect(sortFromId("value-sideways")).toBeUndefined();
  });

  it("gives a holding's return on what it cost from its value and result", () => {
    expect(holdingReturn(apple)).toBeCloseTo(697.17 / (2556.31 - 697.17), 9);
    expect(holdingReturn(coke)).toBeCloseTo(-85.1 / 1492.7, 9);
    expect(holdingReturn(fund)).toBeUndefined();
    expect(holdingReturn(holding("X_EQ", "X", 10, 10))).toBeUndefined();
  });

  it("starts with the table in Trading 212's order, coloured by the day, where nothing is saved or storage is blocked", () => {
    expect(readHoldingsPrefs()).toEqual({ view: "table", sort: undefined, measure: "day" });
  });
});
