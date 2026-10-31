import { describe, expect, it } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import { newListings } from "./new-listings.js";

const now = new Date("2026-10-31T12:00:00Z");
const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const item = (ticker: string, days: number | undefined, type = "STOCK", currencyCode = "USD"): Instrument =>
  ({ ticker, name: ticker.split("_")[0]!, shortName: ticker.split("_")[0]!, currencyCode, type, ...(days === undefined ? {} : { addedOn: at(days) }) });

describe("newListings", () => {
  const list = [
    item("OLD_US_EQ", 400), item("NEW_US_EQ", 2), item("ETF_EQ", 10, "ETF", "EUR"), item("MID_US_EQ", 20),
    item("NODATE_US_EQ", undefined), { ...item("BAD_US_EQ", 1), addedOn: "not a date" }, item("AHEAD_US_EQ", -0.5), item("FAR_US_EQ", -3),
  ];

  it("lists the instruments added in the window, newest first, with counts by type", () => {
    const found = newListings(list, { days: 30 }, now);
    expect(found.listings.map((entry) => entry.ticker)).toEqual(["AHEAD_US_EQ", "NEW_US_EQ", "ETF_EQ", "MID_US_EQ"]);
    expect(found.total).toBe(4);
    expect(found.types).toEqual({ STOCK: 3, ETF: 1 });
    expect(found.undated).toBe(2);
    expect(found.catalogue).toBe(list.length);
    expect(found.from).toBe(at(30));
  });

  it("narrows by type and currency, keeping the type counts of the currency", () => {
    expect(newListings(list, { days: 30, type: "etf" }, now).listings.map((entry) => entry.ticker)).toEqual(["ETF_EQ"]);
    const usd = newListings(list, { days: 30, currency: "usd", type: "STOCK" }, now);
    expect(usd.listings).toHaveLength(3);
    expect(usd.types).toEqual({ STOCK: 3 });
  });

  it("limits the listings but counts every match, and clamps the window", () => {
    const found = newListings(list, { days: 30, limit: 1 }, now);
    expect(found.listings).toHaveLength(1);
    expect(found.total).toBe(4);
    expect(newListings(list, { days: 5000 }, now).total).toBe(4);
    expect(newListings(list, { days: 0 }, now).listings.map((entry) => entry.ticker)).toEqual(["AHEAD_US_EQ"]);
  });
});
