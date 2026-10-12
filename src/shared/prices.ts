// An instrument's daily closing prices, for the price chart on the holding page. Trading 212's Public API has no
// price history, so they come from the quote provider (or, with sample data, a simulated path).

/** One trading day's closing price, in the instrument's currency and unit. */
export interface PricePoint {
  /** The trading day, YYYY-MM-DD. */
  date: string;
  close: number;
}

export interface PriceHistory {
  /** Who the closes are from: a quote provider's name, or "sample" for the simulated account. */
  source: string;
  /** The provider's symbol for the instrument. */
  symbol?: string;
  /** The QUOTE_SYMBOLS factor the provider's closes were multiplied by, when not 1. */
  factor?: number;
  /** Oldest first. */
  points: PricePoint[];
}

/**
 * Why there are no closes: no quote provider, one whose free plan has no daily prices, no provider symbol for
 * the instrument, no answer, closes in another unit than Trading 212's, or an instrument the sample account
 * does not hold.
 */
export type PricesMissing = "provider" | "plan" | "symbol" | "data" | "unit" | "sample";

/** Ranges the chart offers, in days back from the newest close. */
export const PRICE_RANGES = [
  ["1m", 31],
  ["3m", 92],
  ["6m", 183],
  ["1y", 366],
] as const;
export type PriceRange = (typeof PRICE_RANGES)[number][0];

const DAY_MS = 86_400_000;

/** Slack for a range's start falling on a weekend or holiday, so a year of trading days counts as a year. */
export const RANGE_SLACK_DAYS = 6;

/** Whether the closes reach back over a whole range of `days` before the newest close. */
export function rangeCovered(points: PricePoint[], days: number): boolean {
  const first = points[0];
  const last = points[points.length - 1];
  return !!first && !!last && Date.parse(`${first.date}T00:00:00Z`) <= Date.parse(`${last.date}T00:00:00Z`) - (days - RANGE_SLACK_DAYS) * DAY_MS;
}

/** The closes in a range: from `days` before the newest close to it. */
export function pricesIn(points: PricePoint[], days: number): PricePoint[] {
  const last = points[points.length - 1];
  if (!last) return [];
  const start = Date.parse(`${last.date}T00:00:00Z`) - days * DAY_MS;
  return points.filter((point) => Date.parse(`${point.date}T00:00:00Z`) >= start);
}

/** How a run of closes went: first and last, the change between them, and the highest and lowest close. */
export interface PriceMove {
  first: PricePoint;
  last: PricePoint;
  change: number;
  high: PricePoint;
  low: PricePoint;
}

export function priceMove(points: PricePoint[]): PriceMove | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return undefined;
  let high = first;
  let low = first;
  for (const point of points) {
    if (point.close > high.close) high = point;
    if (point.close < low.close) low = point;
  }
  return { first, last, change: last.close / first.close - 1, high, low };
}
