// Splits and consolidations in an account's fills. Trading 212 lists one as fills of type STOCK_SPLIT on its day:
// the old shares closed and the new ones opened, or only the shares it added or took away. Either way the holding is
// the same holding in other units, at the same cost: a fill before it is restated in today's units (its shares times
// the ratio, its price divided by it) and the split's own fills are left out, so what is held, matched and drawn
// adds up across it.

import type { HistoryOrderItem } from "./history.js";

export const SPLIT_FILL = "STOCK_SPLIT";
/** One split's fills are listed within this of each other. */
const EVENT_MS = 86_400_000;
const EPSILON = 1e-9;

export const isSplitType = (type: string | undefined) => (type ?? "").toUpperCase() === SPLIT_FILL;

/** A split read: `ratio` shares after it for each one before (2 for 2-for-1, 0.1 for a 1-for-10 consolidation). */
export interface SplitEvent {
  /** The first of its fills. */
  at: string;
  ratio: number;
}

/** A fill as the split reading needs it: its instrument, when, the shares it added (less than 0 for a sale) and whether it was a split. */
export interface SplitRow { key: string; time: number; quantity: number; split: boolean }

export interface SplitsRead<T> {
  /** Each instrument's splits, oldest first. */
  events: Map<string, SplitEvent[]>;
  /** The split fills whose ratio was told, to be left out. */
  used: Set<T>;
  /** The instruments with a split whose ratio cannot be told: its fills are left as they were. */
  unresolved: Set<string>;
}

/**
 * The splits among fills. A split listed as the old shares closed and the new opened has its ratio from the two. One
 * listed as the shares added or taken away alone has it from the shares held across it: worked back from `held`, the
 * shares held now, when it is given (every fill after the split is read, whenever the history starts), else from the
 * fills before it, which add up to the shares held only when the history is read from the first buy. When neither
 * tells, it is left as it was.
 */
export function readSplits<T>(fills: readonly T[], read: (fill: T) => SplitRow | undefined, held?: (key: string) => number | undefined): SplitsRead<T> {
  const byKey = new Map<string, Array<{ fill: T; row: SplitRow }>>();
  for (const fill of fills) {
    const row = read(fill);
    if (!row || !Number.isFinite(row.time)) continue;
    const list = byKey.get(row.key) ?? [];
    list.push({ fill, row });
    byKey.set(row.key, list);
  }
  const events = new Map<string, SplitEvent[]>();
  const used = new Set<T>();
  const unresolved = new Set<string>();
  for (const [key, list] of byKey) {
    if (!list.some(({ row }) => row.split)) continue;
    list.sort((a, b) => a.row.time - b.row.time);
    // Each split's fills: one and those right after it, within a day; with the shares they open and close.
    const groups: Array<{ start: number; end: number; opened: number; closed: number; ratio?: number }> = [];
    for (let index = 0; index < list.length; index++) {
      const { row } = list[index]!;
      if (!row.split) continue;
      let end = index;
      while (end + 1 < list.length && list[end + 1]!.row.split && list[end + 1]!.row.time - row.time <= EVENT_MS) end++;
      let opened = 0, closed = 0;
      for (let at = index; at <= end; at++) {
        const quantity = list[at]!.row.quantity;
        if (quantity > 0) opened += quantity; else closed -= quantity;
      }
      groups.push({ start: index, end, opened, closed, ...(opened > EPSILON && closed > EPSILON ? { ratio: opened / closed } : {}) });
      index = end;
    }
    const now = held?.(key);
    if (now !== undefined && Number.isFinite(now)) {
      // Back from the shares held now: right after a split, those before it are those after less what it added.
      let shares = now;
      let next = list.length - 1;
      for (let group = groups.length - 1; group >= 0; group--) {
        const split = groups[group]!;
        for (; next > split.end; next--) shares -= list[next]!.row.quantity;
        next = split.start - 1;
        const before = shares - split.opened + split.closed;
        split.ratio ??= before > EPSILON && shares > EPSILON ? shares / before : undefined;
        shares = split.ratio ? shares / split.ratio : before;
      }
    } else {
      // On from the first fill read: the shares the fills before a split add up to.
      let shares = 0;
      let next = 0;
      for (const split of groups) {
        for (; next < split.start; next++) shares += list[next]!.row.quantity;
        next = split.end + 1;
        const after = shares + split.opened - split.closed;
        split.ratio ??= shares > EPSILON && after > EPSILON ? after / shares : undefined;
        shares = split.ratio ? shares * split.ratio : after;
      }
    }
    const found: SplitEvent[] = [];
    for (const split of groups) {
      if (split.ratio === undefined || !Number.isFinite(split.ratio) || !(split.ratio > 0) || Math.abs(split.ratio - 1) <= EPSILON) { unresolved.add(key); continue; }
      found.push({ at: new Date(list[split.start]!.row.time).toISOString(), ratio: Math.round(split.ratio * 1e8) / 1e8 });
      for (let at = split.start; at <= split.end; at++) used.add(list[at]!.fill);
    }
    if (found.length) events.set(key, found);
  }
  return { events, used, unresolved };
}

/** Today's shares for each share at `time`: the ratios of every split after it. */
export function splitFactor(splits: readonly SplitEvent[] | undefined, time: number): number {
  let factor = 1;
  for (const split of splits ?? []) if (Date.parse(split.at) > time) factor *= split.ratio;
  return factor;
}

const tickerOf = (item: HistoryOrderItem) => item.order?.ticker ?? item.order?.instrument?.ticker;
/** A history fill's shares, less than 0 for a sale (told by its side, or by the shares it took away). */
export function signedFillQuantity(item: HistoryOrderItem): number {
  const quantity = Math.abs(item.fill?.quantity ?? item.order?.filledQuantity ?? 0);
  return (item.order?.side ?? "").toUpperCase() === "SELL" || (item.fill?.quantity ?? 0) < 0 ? -quantity : quantity;
}

export interface RestatedFills<T> {
  /** The fills with each before a split restated in today's units, without the splits' own fills. */
  items: T[];
  /** Each split read, oldest first, with the ticker it was read under. */
  splits: Array<SplitEvent & { ticker: string }>;
  /** The instruments (by `keyOf`) with a split whose ratio cannot be told: their split fills are left as they were. */
  unresolved: Set<string>;
}

/**
 * History fills restated across the splits among them. `keyOf` groups an instrument's tickers (by ISIN), so a split
 * read under one applies to the fills of the other; `held` is the shares of each held now, where known.
 */
export function restateSplits<T extends HistoryOrderItem>(items: readonly T[], keyOf: (ticker: string) => string = (ticker) => ticker, held?: (key: string) => number | undefined): RestatedFills<T> {
  const read = readSplits(items, (item) => {
    const ticker = tickerOf(item);
    return ticker && item.fill ? { key: keyOf(ticker), time: Date.parse(item.fill.filledAt ?? ""), quantity: signedFillQuantity(item), split: isSplitType(item.fill.type) } : undefined;
  }, held);
  const tickers = new Map<string, string>();
  for (const item of read.used) { const ticker = tickerOf(item)!; tickers.set(keyOf(ticker), ticker); }
  const splits = [...read.events].flatMap(([key, events]) => events.map((event) => ({ ...event, ticker: tickers.get(key) ?? key })))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!read.events.size) return { items: [...items], splits, unresolved: read.unresolved };
  const restated: T[] = [];
  for (const item of items) {
    if (read.used.has(item)) continue;
    const ticker = tickerOf(item);
    const factor = ticker && item.fill ? splitFactor(read.events.get(keyOf(ticker)), Date.parse(item.fill.filledAt ?? "")) : 1;
    if (Math.abs(factor - 1) <= EPSILON || !item.fill) { restated.push(item); continue; }
    const fill = { ...item.fill };
    if (fill.quantity !== undefined) fill.quantity *= factor;
    if (fill.price !== undefined) fill.price /= factor;
    const order = item.order ? { ...item.order } : undefined;
    if (order?.filledQuantity !== undefined) order.filledQuantity *= factor;
    if (order?.quantity !== undefined) order.quantity *= factor;
    restated.push({ ...item, fill, ...(order ? { order } : {}) });
  }
  return { items: restated, splits, unresolved: read.unresolved };
}

/**
 * Whether closes are in today's units across a split: closes not adjusted for it fall (or rise) by its ratio from the
 * last close before it to the first after. Without closes on both sides, they are taken as adjusted.
 */
export function closesAdjusted(closes: ReadonlyArray<{ date: string; close: number }>, split: SplitEvent): boolean {
  const day = split.at.slice(0, 10);
  const before = closes.filter((point) => point.date < day && point.close > 0).at(-1);
  const after = closes.find((point) => point.date >= day && point.close > 0);
  if (!before || !after) return true;
  const move = after.close / before.close;
  // Unadjusted, the move is about 1 / ratio; a day's own move is far less than a split's.
  return !(Math.abs(Math.log(move * split.ratio)) < Math.abs(Math.log(split.ratio)) / 2);
}

/** Closes in today's units: those before a split they are not adjusted for, divided by its ratio. */
export function adjustCloses<P extends { date: string; close: number }>(closes: readonly P[], splits: readonly SplitEvent[] | undefined): P[] {
  const unadjusted = (splits ?? []).filter((split) => !closesAdjusted(closes, split));
  if (!unadjusted.length) return [...closes];
  return closes.map((point) => {
    let factor = 1;
    for (const split of unadjusted) if (point.date < split.at.slice(0, 10)) factor *= split.ratio;
    return factor === 1 ? point : { ...point, close: point.close / factor };
  });
}

/** The ratio a fill's price is divided by to sit on closes as they are: the splits after it that they are adjusted for. */
export function chartFactor(splits: readonly SplitEvent[] | undefined, closes: ReadonlyArray<{ date: string; close: number }>, time: number): number {
  return splitFactor((splits ?? []).filter((split) => closesAdjusted(closes, split)), time);
}
