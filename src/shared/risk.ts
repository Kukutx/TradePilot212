// How much the time-weighted return moved from day to day: its volatility, its best and worst days, how many days it
// rose and fell, and how it moved with a benchmark. Read from the chained return, so deposits and withdrawals are
// neither rises nor falls. Readings can be days apart (the server was off): a stretch of several days counts as that
// many days of variance, and only one-day stretches are days for the best, the worst and the counts.

import type { BenchmarkRisk, DailyMove, ReturnPoint, Risk } from "./history.js";

/** Fewer stretches than this say too little to read a volatility from. */
export const MIN_STRETCHES = 20;
/** A shorter span is too short to give a return a year. */
const MIN_ANNUAL_DAYS = 90;
/** A day that moved less than this did not move: the markets were shut. */
export const FLAT = 0.00001;

const DAY_MS = 86_400_000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits || 0;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

interface Stretch { date: string; days: number; log: number; move: number }

/** Each stretch between two readings: its end date, its length in days, and its move, as a log and as a fraction. */
function stretchesOf(series: ReturnPoint[]): Stretch[] {
  const out: Stretch[] = [];
  for (let index = 1; index < series.length; index++) {
    const before = series[index - 1]!, after = series[index]!;
    const days = daysBetween(before.date, after.date);
    const ratio = (1 + after.return) / (1 + before.return);
    if (!(days > 0) || !(ratio > 0)) continue;
    out.push({ date: after.date, days, log: Math.log(ratio), move: ratio - 1 });
  }
  return out;
}

/** The moves of the one-day stretches that moved, oldest first: what the daily-moves chart counts. */
export function dailyMoves(series: ReturnPoint[]): DailyMove[] {
  return stretchesOf(series).filter((stretch) => stretch.days === 1 && Math.abs(stretch.move) >= FLAT).map((stretch) => ({ date: stretch.date, return: round(stretch.move) }));
}

/** The per-day variance of the moves, each stretch weighted by its length, and their per-day mean. */
function perDay(stretches: Stretch[], logOf: (stretch: Stretch) => number): { mean: number; variance: number } {
  const days = stretches.reduce((sum, stretch) => sum + stretch.days, 0);
  const mean = stretches.reduce((sum, stretch) => sum + logOf(stretch), 0) / days;
  const variance = stretches.reduce((sum, stretch) => sum + (logOf(stretch) - mean * stretch.days) ** 2 / stretch.days, 0) / (stretches.length - 1);
  return { mean, variance };
}

/** The risk of the return over its series; undefined with fewer than 20 stretches between readings. */
export function riskOf(series: ReturnPoint[]): Risk | undefined {
  const stretches = stretchesOf(series);
  if (stretches.length < MIN_STRETCHES) return undefined;
  const days = stretches.reduce((sum, stretch) => sum + stretch.days, 0);
  const { variance } = perDay(stretches, (stretch) => stretch.log);
  const volatility = Math.sqrt(variance * 365);
  const moves = dailyMoves(series);
  const best = moves.reduce<DailyMove | undefined>((top, move) => (move.return > 0 && (!top || move.return > top.return) ? move : top), undefined);
  const worst = moves.reduce<DailyMove | undefined>((low, move) => (move.return < 0 && (!low || move.return < low.return) ? move : low), undefined);
  const growth = stretches.reduce((product, stretch) => product * (1 + stretch.move), 1);
  const annualized = days >= MIN_ANNUAL_DAYS ? growth ** (365 / days) - 1 : undefined;
  return {
    stretches: stretches.length,
    days,
    volatility: round(volatility),
    up: moves.filter((move) => move.return > 0).length,
    down: moves.filter((move) => move.return < 0).length,
    ...(best ? { best } : {}),
    ...(worst ? { worst } : {}),
    ...(annualized !== undefined ? { annualized: round(annualized) } : {}),
    ...(annualized !== undefined && volatility > 0 ? { ratio: round(annualized / volatility, 2) } : {}),
  };
}

/**
 * The benchmark's volatility, and the return's beta and correlation to it, over the stretches both have (its series is
 * on the return's days); undefined with fewer than 20, or when the benchmark never moved.
 */
export function benchmarkRiskOf(series: ReturnPoint[], benchmark: ReturnPoint[]): BenchmarkRisk | undefined {
  const theirs = new Map(stretchesOf(benchmark).map((stretch) => [stretch.date, stretch]));
  const pairs = stretchesOf(series).flatMap((stretch) => {
    const other = theirs.get(stretch.date);
    return other && other.days === stretch.days ? [{ ours: stretch, theirs: other }] : [];
  });
  if (pairs.length < MIN_STRETCHES) return undefined;
  const ours = perDay(pairs.map((pair) => pair.ours), (stretch) => stretch.log);
  const bench = perDay(pairs.map((pair) => pair.theirs), (stretch) => stretch.log);
  if (!(bench.variance > 0) || !(ours.variance > 0)) return undefined;
  const covariance = pairs.reduce((sum, pair) => sum + (pair.ours.log - ours.mean * pair.ours.days) * (pair.theirs.log - bench.mean * pair.theirs.days) / pair.ours.days, 0) / (pairs.length - 1);
  return {
    volatility: round(Math.sqrt(bench.variance * 365)),
    beta: round(covariance / bench.variance, 2),
    correlation: round(covariance / Math.sqrt(ours.variance * bench.variance), 2),
  };
}
