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
  /** The account's fills of the instrument: the unit check's fallback when not held, and the sample path's anchors. */
  fills?: Promise<PriceAnchor[]>;
}

export type PriceHistoryResult = { prices: PriceHistory } | { missing: PricesMissing; problem: string };

/**
 * A provider's close this many times Trading 212's price, either way, is taken to be in another unit (a fund
 * quoted in pounds that Trading 212 prices in pence), not a real move.
 */
const UNIT_RATIO = 10;

export function createPriceHistory(deps: { sampleData: boolean; quotes?: QuoteProvider; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => {
    const { instrument } = request;
    if (deps.sampleData) {
      if (!request.last) return { missing: "sample", problem: "The sample account has prices only for the instruments it holds." };
      return { prices: samplePriceHistory(instrument.ticker, { from: request.from, to: now(), last: request.last, anchors: await request.fills ?? [] }) };
    }
    const quotes = deps.quotes;
    if (!quotes) return { missing: "provider", problem: "No quote provider is configured (QUOTE_PROVIDER, QUOTE_API_KEY), so there is no price chart." };
    if (!quotes.history) return { missing: "plan", problem: `The ${quotes.name} free plan has no daily prices; QUOTE_PROVIDER=stooq, twelvedata or alphavantage draws the chart.` };
    const symbol = quotes.symbolFor(instrument);
    if (!symbol) return { missing: "symbol", problem: `${instrument.ticker} has no ${quotes.name} symbol; add it to QUOTE_SYMBOLS for a price chart.` };
    const prices = await quotes.history(instrument, request.from);
    if (!prices) return { missing: "data", problem: `${quotes.name} returned no daily prices for ${symbol}.` };
    const newest = (await request.fills ?? []).reduce<PriceAnchor | undefined>((best, item) => (!best || item.at > best.at ? item : best), undefined);
    const reference = request.last ?? newest?.price;
    const last = prices.points[prices.points.length - 1]!.close;
    if (reference && (last / reference >= UNIT_RATIO || last / reference <= 1 / UNIT_RATIO)) {
      return { missing: "unit", problem: `${quotes.name}'s closes for ${symbol} (last ${last}) are far from Trading 212's price (${reference}), so they look like another unit; map it with a factor in QUOTE_SYMBOLS, e.g. ${instrument.ticker}=${symbol}*100.` };
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
