// Where the holdings' risk is: each holding's share of the portfolio's volatility beside its share of the value, read
// from a year of weekly closes. Weekly returns keep markets that close at different hours and on different holidays
// in step, which daily ones do not (a London close is hours before a New York one). They are in each instrument's own
// currency, so currency moves are not in them.

import type { HoldingRisk, HoldingRiskRow } from "./history.js";
import type { PricePoint } from "./prices.js";

/** No more weekly returns than this, together, say too little to read a volatility or a correlation from. */
export const MIN_WEEKS = 26;
/** The correlations are shown between this many holdings at most, the largest by value. */
export const MATRIX_SIZE = 10;
/** Weeks in a year: a week's variance times this is a year's. */
const WEEKS_A_YEAR = 52;
/** Below this variance a year (a volatility of 0.1%) the holdings did not move: there is no risk to share. */
const FLAT_VARIANCE = 1e-6;
/**
 * A holding with fewer weekly closes than this share of the most any has is left out, rather than cut the weeks all
 * the others are read over (a holding bought into the year's second half, closes that stopped).
 */
const COVERAGE = 0.75;
/** A week's close five times the last, or a fifth of it, is a change of unit (pounds to pence) or a split, not a move. */
const JUMP = Math.log(5);

const DAY_MS = 86_400_000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits || 0;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
/** Monday 0 … Sunday 6. Day 0, 1 January 1970, was a Thursday. */
const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;
/** The Monday a day's week starts on. */
const weekOf = (day: number) => day - weekdayOf(day);

export interface HoldingRiskInput {
  ticker: string;
  /** Its value now, in the account currency. */
  value: number;
  /** Its daily closes, oldest first, in its own currency. */
  points: PricePoint[];
}

/** Each week's last close by the Monday it starts on; the week of `today` only once it is over (from Saturday). */
function weeklyCloses(points: PricePoint[], today: string): Map<number, { date: string; close: number }> {
  const now = dayNumber(today);
  const open = weekdayOf(now) < 5 ? weekOf(now) : undefined;
  const weeks = new Map<number, { date: string; close: number }>();
  for (const point of points) {
    const day = dayNumber(point.date);
    if (!Number.isFinite(day) || !(point.close > 0) || day > now) continue;
    const week = weekOf(day);
    if (week === open) continue;
    const seen = weeks.get(week);
    if (!seen || seen.date <= point.date) weeks.set(week, { date: point.date, close: point.close });
  }
  return weeks;
}

type WeeklyInput = HoldingRiskInput & { weeks: Map<number, { date: string; close: number }> };

/** The weeks every holding has a close in, oldest first. */
function sharedWeeks(inputs: WeeklyInput[]): number[] {
  if (!inputs.length) return [];
  return [...inputs[0]!.weeks.keys()].filter((week) => inputs.every((input) => input.weeks.has(week))).sort((a, b) => a - b);
}

/** Whether a holding's closes jump, from one week's to the next, by more than any real move. */
function jumps(weeks: WeeklyInput["weeks"]): boolean {
  const closes = [...weeks].sort(([a], [b]) => a - b).map(([, week]) => week.close);
  return closes.some((close, index) => index > 0 && Math.abs(Math.log(close / closes[index - 1]!)) > JUMP);
}

/**
 * Each holding's share of the portfolio's risk, from the weeks every holding measured has a close in. A holding with
 * no more than MIN_WEEKS weekly returns, or fewer than COVERAGE of the most any has, is left out (`short`), as is one
 * whose weeks do not line up with the rest's when no more than MIN_WEEKS are shared, and one whose closes jump
 * (`jumps`). The others are weighed among themselves; `totalValue` is the value of all the holdings, those without
 * closes included, for the share measured. Undefined when fewer than two holdings, or no more than MIN_WEEKS weeks
 * together, are left, or nothing moved.
 */
export function holdingRiskOf(inputs: HoldingRiskInput[], today: string, totalValue?: number): HoldingRisk | undefined {
  const valued = inputs.filter((input) => input.value > 0 && Number.isFinite(input.value));
  // The holdings' value, those without closes included, for the share measured.
  const total = Math.max(totalValue ?? 0, valued.reduce((sum, input) => sum + input.value, 0));
  const read: WeeklyInput[] = valued.map((input) => ({ ...input, weeks: weeklyCloses(input.points, today) }));
  const jumped = read.filter((input) => jumps(input.weeks));
  const steady = read.filter((input) => !jumped.includes(input));
  const most = Math.max(0, ...steady.map((input) => input.weeks.size));
  // Weekly returns are one fewer than the weekly closes.
  const enough = (input: WeeklyInput) => input.weeks.size - 1 > MIN_WEEKS && input.weeks.size >= most * COVERAGE;
  const short = steady.filter((input) => !enough(input)).map((input) => input.ticker);
  let measured = steady.filter(enough);
  let common = sharedWeeks(measured);
  // Weeks that do not line up (a gap in one, another's closes stopping early): leave out, one at a time, the holding
  // whose absence leaves the most weeks shared, until enough are.
  while (common.length - 1 <= MIN_WEEKS && measured.length > 2) {
    const without = measured.map((left) => sharedWeeks(measured.filter((input) => input !== left)));
    const best = without.reduce((at, weeks, index) => (weeks.length > without[at]!.length ? index : at), 0);
    if (without[best]!.length <= common.length) break;
    short.push(measured[best]!.ticker);
    measured = measured.filter((_, index) => index !== best);
    common = without[best]!;
  }
  if (measured.length < 2 || common.length - 1 <= MIN_WEEKS) return undefined;
  // Weekly log returns; a gap of whole weeks (a market shut all week) counts as that many weeks of variance.
  const returns = measured.map((input) => common.slice(1).map((week, index) => {
    const before = common[index]!;
    return Math.log(input.weeks.get(week)!.close / input.weeks.get(before)!.close) / Math.sqrt((week - before) / 7);
  }));
  const n = common.length - 1;
  const means = returns.map((series) => series.reduce((sum, value) => sum + value, 0) / n);
  const covariance = returns.map((a, i) => returns.map((b, j) => a.reduce((sum, value, k) => sum + (value - means[i]!) * (b[k]! - means[j]!), 0) / (n - 1) * WEEKS_A_YEAR));
  const value = measured.reduce((sum, input) => sum + input.value, 0);
  const weights = measured.map((input) => input.value / value);
  // Each holding's covariance with the portfolio, and the portfolio's variance.
  const withPortfolio = covariance.map((row) => row.reduce((sum, cell, j) => sum + cell * weights[j]!, 0));
  const variance = withPortfolio.reduce((sum, cell, i) => sum + cell * weights[i]!, 0);
  if (!(variance > FLAT_VARIANCE)) return undefined;
  const volatility = Math.sqrt(variance);
  const own = covariance.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  const rows: HoldingRiskRow[] = measured.map((input, i) => ({
    ticker: input.ticker,
    weight: round(weights[i]!),
    volatility: round(own[i]!),
    risk: round(weights[i]! * withPortfolio[i]! / variance),
    correlation: own[i]! > 0 ? round(Math.max(-1, Math.min(1, withPortfolio[i]! / (own[i]! * volatility)))) : 0,
  })).sort((a, b) => b.risk - a.risk || b.weight - a.weight);
  const largest = measured.map((input, i) => ({ ticker: input.ticker, i, value: input.value }))
    .sort((a, b) => b.value - a.value).slice(0, MATRIX_SIZE);
  const correlation = (i: number, j: number) => (i === j ? 1 : own[i]! > 0 && own[j]! > 0 ? round(Math.max(-1, Math.min(1, covariance[i]![j]! / (own[i]! * own[j]!))), 4) : 0);
  const first = measured[0]!.weeks.get(common[0]!)!.date;
  const last = measured.map((input) => input.weeks.get(common[n]!)!.date).sort().at(-1)!;
  return {
    from: first,
    to: last,
    weeks: n,
    volatility: round(volatility),
    diversification: round(measured.reduce((sum, _, i) => sum + weights[i]! * own[i]!, 0) / volatility, 4),
    covered: round(value / total, 4),
    rows,
    correlations: { tickers: largest.map((entry) => entry.ticker), matrix: largest.map((a) => largest.map((b) => correlation(a.i, b.i))) },
    ...(short.length ? { short } : {}),
    ...(jumped.length ? { jumps: jumped.map((input) => input.ticker) } : {}),
  };
}
