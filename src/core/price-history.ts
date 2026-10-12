// Daily closes for the price chart on the holding page. Trading 212's Public API has no price history, so they come
// from the quote provider; the sample account draws a simulated path through its own fills instead.

import type { Instrument } from "../shared/contracts.js";
import type { PriceHistory, PricePoint, PricesMissing } from "../shared/prices.js";
import type { QuoteProvider } from "./quotes.js";

const DAY_MS = 86_400_000;

/** A price the instrument was traded at, and when. */
export interface PriceAnchor {
  at: string;
  price: number;
}

export interface PriceHistoryRequest {
  instrument: Instrument;
  from: Date;
  /** Trading 212's last price, when held: the provider's closes are checked against it for the unit. */
  last?: number;
  /**
   * The quote provider's price, when not held (it can still be on its way): where the sample path ends. Coming from
   * the provider itself, it is no check on the unit.
   */
  quote?: Promise<number | undefined>;
  /** The prices of the instrument's open orders and armed alerts: the unit check's reference when it is not held. */
  levels?: Promise<number[]>;
  /** The account's fills of the instrument: the unit check's last resort, and the sample path's anchors. */
  fills?: Promise<PriceAnchor[]>;
}

export type PriceHistoryResult = { prices: PriceHistory } | { missing: PricesMissing; problem: string };

/**
 * A provider's close this many times Trading 212's price, either way, is taken to be in another unit (a fund
 * quoted in pounds that Trading 212 prices in pence), not a real move. A past fill may sit far from today's
 * closes after a split, so against a fill only a gap of UNIT_RATIO_FILL counts.
 */
const UNIT_RATIO = 10;
const UNIT_RATIO_FILL = 50;
/** The holding page waits this long for the closes; a slower answer is cached for the next look. */
const HISTORY_WAIT_MS = 3000;

/** What `promise` gives within `ms`, else undefined; the promise itself runs on (a provider read fills its cache). */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The QUOTE_SYMBOLS factor that brings closes at `last` to Trading 212's `reference`: a power of ten times the one mapped. */
export function unitFactor(last: number, reference: number, mapped = 1): number {
  return Number((mapped * 10 ** Math.round(Math.log10(reference / last))).toPrecision(6));
}

const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** What a provider's price is checked against for its unit, and how far off counts. */
export interface UnitReference { price: number; ratio: number; what: string }

/** Trading 212's last price, else the middle of the open orders and alerts, else the newest fill (with more room). */
export function unitReference(last: number | undefined, levels: number[], fills: PriceAnchor[]): UnitReference | undefined {
  const priced = levels.filter((price) => price > 0);
  const newest = fills.reduce<PriceAnchor | undefined>((best, item) => (!best || item.at > best.at ? item : best), undefined);
  return last ? { price: last, ratio: UNIT_RATIO, what: "last price" }
    : priced.length ? { price: middle(priced)!, ratio: UNIT_RATIO, what: "order and alert prices" }
    : newest ? { price: newest.price, ratio: UNIT_RATIO_FILL, what: "newest fill" }
    : undefined;
}

/** Whether a provider's price is far enough from the reference to be in another unit. */
export const offUnit = (price: number, reference: UnitReference) => price / reference.price >= reference.ratio || reference.price / price >= reference.ratio;

/**
 * Why the provider's quote of an instrument not held looks like another unit, when it does: it comes from the same
 * mapping as the closes, so it is checked the same way, also when the closes did not come.
 */
export function quoteUnitProblem(quote: { price: number; symbol: string; source: string }, ticker: string, reference: UnitReference | undefined): string | undefined {
  if (!reference || !offUnit(quote.price, reference)) return undefined;
  const factor = unitFactor(quote.price, reference.price);
  return `${quote.source}'s price for ${quote.symbol} (${quote.price}) is far from Trading 212's ${reference.what} (${reference.price}), so it looks like another unit; multiply the factor in its QUOTE_SYMBOLS mapping by ${factor} (${ticker}=${quote.symbol}*${factor} when it has none).`;
}

export function createPriceHistory(deps: {
  sampleData: boolean;
  quotes?: QuoteProvider;
  /** The sample account's fills of an instrument, for a request that brings none: each view draws the same path. */
  sampleAnchors?: (instrument: Instrument, from: Date) => Promise<PriceAnchor[]>;
  now?: () => Date;
  waitMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  return async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => {
    const { instrument } = request;
    if (deps.sampleData) {
      const last = request.last ?? await request.quote;
      if (!last) return { missing: "sample", problem: "The sample account has prices only for its own instruments." };
      const anchors = await (request.fills ?? deps.sampleAnchors?.(instrument, request.from).catch(() => []));
      return { prices: samplePriceHistory(instrument.ticker, { from: request.from, to: now(), last, anchors: anchors ?? [] }) };
    }
    const quotes = deps.quotes;
    if (!quotes) return { missing: "provider", problem: "No quote provider is configured (QUOTE_PROVIDER, QUOTE_API_KEY), so there is no price chart." };
    if (!quotes.history) return { missing: "plan", problem: `The ${quotes.name} free plan has no daily prices; QUOTE_PROVIDER=stooq, twelvedata or alphavantage draws the chart.` };
    const symbol = quotes.symbolFor(instrument);
    if (!symbol) return { missing: "symbol", problem: `${instrument.ticker} has no ${quotes.name} symbol; add it to QUOTE_SYMBOLS for a price chart.` };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deps.waitMs ?? HISTORY_WAIT_MS); });
    let prices: Awaited<ReturnType<NonNullable<QuoteProvider["history"]>>> | "late";
    try {
      prices = await Promise.race([quotes.history(instrument, request.from), late]);
    } catch (error) {
      return { missing: "data", problem: `${quotes.name} gave no daily prices for ${symbol}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
    if (prices === "late") return { missing: "data", problem: `${quotes.name} took more than ${(deps.waitMs ?? HISTORY_WAIT_MS) / 1000} seconds for ${symbol}'s daily prices; they show the next time the page opens.` };
    if (!prices) return { missing: "data", problem: `${quotes.name} returned no daily prices for ${symbol}.` };
    // The unit is checked against the last price, else the open orders and alerts, else the newest fill.
    const check = unitReference(request.last, await request.levels ?? [], await request.fills ?? []);
    const last = prices.points[prices.points.length - 1]!.close;
    if (check && offUnit(last, check)) {
      const factor = unitFactor(last, check.price, prices.factor);
      const mapping = `${instrument.ticker}=${symbol}${factor === 1 ? "" : `*${factor}`}`;
      return { missing: "unit", problem: `${quotes.name}'s closes for ${symbol} (last ${last}) are far from Trading 212's ${check.what} (${check.price}), so they look like another unit; map it in QUOTE_SYMBOLS as ${mapping}.` };
    }
    return { prices };
  };
}

/** Daily volatility of the simulated walk. */
const SAMPLE_DAILY_MOVE = 0.015;

/** FNV-1a, so each ticker seeds its own path. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/** mulberry32: a small seeded generator, so a ticker draws the same path on every call. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const dayOf = (time: number) => Math.floor(time / DAY_MS);
const weekday = (day: number) => { const weekdayIndex = new Date(day * DAY_MS).getUTCDay(); return weekdayIndex !== 0 && weekdayIndex !== 6; };

/**
 * A simulated year of weekday closes for the sample account: a seeded random walk that passes through each of the
 * account's fills (on the last weekday at or before it) and ends at the last price, so the chart's trade markers
 * sit on its line. Between two fixed prices the walk is a Brownian bridge in log price. Not a real price.
 */
export function samplePriceHistory(ticker: string, input: { from: Date; to: Date; last: number; anchors: PriceAnchor[] }): PriceHistory {
  const days: number[] = [];
  for (let day = dayOf(input.from.getTime()); day <= dayOf(input.to.getTime()); day++) if (weekday(day)) days.push(day);
  const random = seeded(seedOf(ticker));
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const walk = [0];
  for (let index = 1; index < days.length; index++) walk.push(walk[index - 1]! + SAMPLE_DAILY_MOVE * normal());
  // Fixed log prices by day index; a later anchor on the same day wins, and the last price fixes the last day.
  const fixed = new Map<number, number>();
  const indexOf = (time: number) => { const day = dayOf(time); let found = -1; for (let index = 0; index < days.length && days[index]! <= day; index++) found = index; return found; };
  for (const anchor of [...input.anchors].sort((a, b) => a.at.localeCompare(b.at))) {
    const index = indexOf(Date.parse(anchor.at));
    if (index >= 0 && anchor.price > 0) fixed.set(index, Math.log(anchor.price));
  }
  if (days.length) fixed.set(days.length - 1, Math.log(input.last));
  const anchors = [...fixed].sort(([a], [b]) => a - b);
  const log = new Array<number>(days.length);
  const [firstIndex, firstLog] = anchors[0] ?? [0, Math.log(input.last)];
  for (let index = 0; index <= firstIndex; index++) log[index] = firstLog + walk[index]! - walk[firstIndex]!;
  for (let pair = 1; pair < anchors.length; pair++) {
    const [start, startLog] = anchors[pair - 1]!;
    const [end, endLog] = anchors[pair]!;
    for (let index = start; index <= end; index++) {
      const share = (index - start) / (end - start);
      log[index] = startLog + share * (endLog - startLog) + (walk[index]! - walk[start]!) - share * (walk[end]! - walk[start]!);
    }
  }
  const digits = input.last >= 1000 ? 1 : input.last >= 10 ? 2 : 4;
  const points: PricePoint[] = days.map((day, index) => ({
    date: new Date(day * DAY_MS).toISOString().slice(0, 10),
    close: Math.round(Math.exp(log[index]!) * 10 ** digits) / 10 ** digits,
  }));
  return { source: "sample", points };
}
