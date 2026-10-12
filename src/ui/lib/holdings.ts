// How the dashboard orders and shows the holdings: Trading 212's order or a column, as a table or as a map, kept per
// viewer when the host allows local storage.

import type { Position } from "../../shared/contracts";
import type { DayMove } from "../../shared/today";
import { instrumentLabel, type InstrumentBook } from "./instruments";
import { walletNumber } from "./format";

export type HoldingsSortKey = "value" | "day" | "pnl" | "name";
/** A column and its direction; none keeps Trading 212's order. */
export type HoldingsSort = { key: HoldingsSortKey; direction: "asc" | "desc" } | undefined;
export type HoldingsView = "table" | "map";
/** What the map's colour shows: the day's move, or the return since bought. */
export type MapMeasure = "day" | "total";

/** Every order the sort menu offers: each number column both ways, names A to Z. */
export const SORT_CHOICES: Array<Exclude<HoldingsSort, undefined>> = [
  { key: "value", direction: "desc" },
  { key: "value", direction: "asc" },
  { key: "day", direction: "desc" },
  { key: "day", direction: "asc" },
  { key: "pnl", direction: "desc" },
  { key: "pnl", direction: "asc" },
  { key: "name", direction: "asc" },
];

export const sortId = (sort: HoldingsSort) => (sort ? `${sort.key}-${sort.direction}` : "default");
export const sortFromId = (id: string): HoldingsSort => SORT_CHOICES.find((choice) => sortId(choice) === id);

/**
 * What a column header does to the order: a number column sorts largest first, then smallest first, then back to
 * Trading 212's order; the name sorts A to Z, then back.
 */
export function nextSort(current: HoldingsSort, key: HoldingsSortKey): HoldingsSort {
  if (current?.key !== key) return { key, direction: key === "name" ? "asc" : "desc" };
  if (key !== "name" && current.direction === "desc") return { key, direction: "asc" };
  return undefined;
}

/** A holding's return on what it cost, in the account currency: its unrealized result against its value less that result. */
export function holdingReturn(position: Position): number | undefined {
  const value = walletNumber(position, "currentValue");
  const result = walletNumber(position, "unrealizedProfitLoss");
  if (value === undefined || result === undefined) return undefined;
  const cost = value - result;
  return cost > 0 ? result / cost : undefined;
}

/** The holdings in the chosen order; ones without the figure sorted on go last either way, in Trading 212's order. */
export function sortHoldings(positions: Position[], sort: HoldingsSort, moves: Map<string, DayMove>, book?: InstrumentBook, locale = "en"): Position[] {
  if (!sort) return positions;
  const figure = (position: Position): number | string | undefined => {
    switch (sort.key) {
      case "value": return walletNumber(position, "currentValue");
      case "pnl": return walletNumber(position, "unrealizedProfitLoss");
      case "day": return moves.get(position.instrument.ticker)?.change;
      case "name": return instrumentLabel(position.instrument.ticker, book, position.instrument).name;
    }
  };
  const sign = sort.direction === "asc" ? 1 : -1;
  return positions
    .map((position, index) => ({ position, index, value: figure(position) }))
    .sort((a, b) => {
      if (a.value === undefined || b.value === undefined) return a.value === b.value ? a.index - b.index : a.value === undefined ? 1 : -1;
      const order = typeof a.value === "string" ? a.value.localeCompare(String(b.value), locale, { sensitivity: "base" }) : a.value - (b.value as number);
      return order * sign || a.index - b.index;
    })
    .map((entry) => entry.position);
}

const VIEW_KEY = "tradepilot212.holdingsView";
const SORT_KEY = "tradepilot212.holdingsSort";
const MEASURE_KEY = "tradepilot212.mapMeasure";

export interface HoldingsPrefs { view: HoldingsView; sort: HoldingsSort; measure: MapMeasure }

/** The viewer's last table-or-map choice, order and map colour; the table in Trading 212's order when none is saved. */
export function readHoldingsPrefs(): HoldingsPrefs {
  try {
    return {
      view: localStorage.getItem(VIEW_KEY) === "map" ? "map" : "table",
      sort: sortFromId(localStorage.getItem(SORT_KEY) ?? ""),
      measure: localStorage.getItem(MEASURE_KEY) === "total" ? "total" : "day",
    };
  } catch {
    return { view: "table", sort: undefined, measure: "day" };
  }
}

export function saveHoldingsPrefs(prefs: HoldingsPrefs): void {
  try {
    localStorage.setItem(VIEW_KEY, prefs.view);
    localStorage.setItem(SORT_KEY, sortId(prefs.sort));
    localStorage.setItem(MEASURE_KEY, prefs.measure);
  } catch {
    // Sandboxed hosts may block storage; the choice then lasts while the widget is open.
  }
}
