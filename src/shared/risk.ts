// How much the time-weighted return moved from day to day: its volatility, its best and worst days, how many days it
// rose and fell, and how it moved with a benchmark. Read from the chained return, so deposits and withdrawals are
// neither rises nor falls. Markets trade on weekdays, so a stretch between readings counts the weekdays it covers: a
// reading at the weekend joins its stretch to the next one, readings days apart (the server was off) count as that
// many days of variance, and only one-weekday stretches are days for the best, the worst and the counts.

import type { BenchmarkRisk, DailyMove, ReturnPoint, Risk } from "./history.js";

/** Fewer stretches than this say too little to read a volatility from. */
export const MIN_STRETCHES = 20;
/** A shorter span gives no return a year, as for the money-weighted return. */
const MIN_ANNUAL_DAYS = 365;
/** Below this volatility a year the account is as good as cash, and the return over it says nothing. */
const MIN_RATIO_VOLATILITY = 0.005;
/** A day that moved less than this did not move: the markets were shut (a holiday). */
export const FLAT = 0.00005;
/** Weekdays in a year: a weekday's variance times this is a year's, holidays being weekdays that did not move. */
const WEEKDAYS_A_YEAR = 261;

const DAY_MS = 86_400_000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits || 0;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** The weekdays after `from`, up to and including `to`. */
function weekdaysBetween(from: string, to: string): number {
  const start = dayNumber(from), end = dayNumber(to);
  if (!(end > start)) return 0;
  const weeks = Math.floor((end - start) / 7);
  let count = weeks * 5;
  // Day 0, 1 January 1970, was a Thursday.
  for (let day = start + weeks * 7 + 1; day <= end; day++) if ((((day + 4) % 7) + 7) % 7 % 6 !== 0) count++;
  return count;
}

interface Stretch { from: string; date: string; days: number; log: number; move: number }

/** Each stretch between two readings: its first and last date, its weekdays, and its move as a log and a fraction. */
function stretchesOf(series: ReturnPoint[]): Stretch[] {
  const out: Stretch[] = [];
  let start = series[0]!;
  for (const point of series.slice(1)) {
    const days = weekdaysBetween(start.date, point.date);
    // A reading at the weekend (or not after the one before) joins the next stretch.
    if (!(days > 0)) continue;
    const ratio = (1 + point.return) / (1 + start.return);
    if (ratio > 0) out.push({ from: start.date, date: point.date, days, log: Math.log(ratio), move: ratio - 1 });
    start = point;
  }
  return out;
}

/** The stretches to read: the ones that end before today, since today's last reading may come before the close. */
const settled = (stretches: Stretch[], today?: string) => (today ? stretches.filter((stretch) => stretch.date < today) : stretches);

const movedDays = (stretches: Stretch[]): DailyMove[] =>
  stretches.filter((stretch) => stretch.days === 1 && Math.abs(stretch.move) >= FLAT).map((stretch) => ({ date: stretch.date, return: round(stretch.move) }));

/** The moves of the one-weekday stretches that moved, up to `to` (the risk's last day), oldest first: what the daily-moves chart counts. */
export function dailyMoves(series: ReturnPoint[], to?: string): DailyMove[] {
  return movedDays(stretchesOf(series).filter((stretch) => !to || stretch.date <= to));
}

/** The per-weekday variance of the moves, each stretch weighted by its weekdays, and their per-weekday mean. */
function perDay(stretches: Stretch[]): { mean: number; variance: number } {
  const days = stretches.reduce((sum, stretch) => sum + stretch.days, 0);
  const mean = stretches.reduce((sum, stretch) => sum + stretch.log, 0) / days;
  const variance = stretches.reduce((sum, stretch) => sum + (stretch.log - mean * stretch.days) ** 2 / stretch.days, 0) / (stretches.length - 1);
  return { mean, variance };
}

/** The risk of the return over its series, leaving out stretches that end on `today`; undefined with fewer than 20 stretches. */
export function riskOf(series: ReturnPoint[], today?: string): Risk | undefined {
  const stretches = settled(stretchesOf(series), today);
  if (stretches.length < MIN_STRETCHES) return undefined;
  const first = stretches[0]!, last = stretches[stretches.length - 1]!;
  const days = stretches.reduce((sum, stretch) => sum + stretch.days, 0);
  const volatility = Math.sqrt(perDay(stretches).variance * WEEKDAYS_A_YEAR);
  const moves = movedDays(stretches);
  const best = moves.reduce<DailyMove | undefined>((top, move) => (move.return > 0 && (!top || move.return > top.return) ? move : top), undefined);
  const worst = moves.reduce<DailyMove | undefined>((low, move) => (move.return < 0 && (!low || move.return < low.return) ? move : low), undefined);
  const span = dayNumber(last.date) - dayNumber(first.from);
  const growth = stretches.reduce((product, stretch) => product * (1 + stretch.move), 1);
  const annualized = span >= MIN_ANNUAL_DAYS ? growth ** (365 / span) - 1 : undefined;
  return {
    from: first.from,
    to: last.date,
    stretches: stretches.length,
    days,
    volatility: round(volatility),
    up: moves.filter((move) => move.return > 0).length,
    down: moves.filter((move) => move.return < 0).length,
    ...(best ? { best } : {}),
    ...(worst ? { worst } : {}),
    ...(annualized !== undefined ? { annualized: round(annualized) } : {}),
    ...(annualized !== undefined && volatility >= MIN_RATIO_VOLATILITY ? { ratio: round(annualized / volatility, 2) } : {}),
  };
}

/** Weighted least squares without an intercept (the inputs are taken off their means): undefined when they do not tell the coefficients apart. */
function leastSquares(rows: Array<{ target: number; inputs: number[]; weight: number }>): number[] | undefined {
  const size = rows[0]?.inputs.length ?? 0;
  // The normal equations, each row of the matrix with its right-hand side at the end.
  const matrix = Array.from({ length: size }, (_, row) => [
    ...Array.from({ length: size }, (_, column) => rows.reduce((sum, item) => sum + item.weight * item.inputs[row]! * item.inputs[column]!, 0)),
    rows.reduce((sum, item) => sum + item.weight * item.inputs[row]! * item.target, 0),
  ]);
  const scale = Math.max(...matrix.map((row, index) => Math.abs(row[index]!)));
  for (let column = 0; column < size; column++) {
    const pivot = matrix.slice(column).reduce((best, row, offset) => (Math.abs(row[column]!) > Math.abs(matrix[best]![column]!) ? column + offset : best), column);
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const lead = matrix[column]![column]!;
    if (!(Math.abs(lead) > scale * 1e-9)) return undefined;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]! / lead;
      for (let index = column; index <= size; index++) matrix[row]![index]! -= factor * matrix[column]![index]!;
    }
  }
  return matrix.map((row, index) => row[size]! / row[index]!);
}

/**
 * The benchmark's volatility, and the return's beta and correlation to it, over the stretches both have (its series
 * is on the return's days), leaving out stretches that end on `today`; undefined with fewer than 20, or when either
 * never moved. The return's readings can come at any time of day, often before the benchmark's close, so a day's
 * reading can hold part of the benchmark's day before (or, for a benchmark on a later market, after). So each of the
 * return's stretches is fitted to the benchmark's stretch before, the same one and the one after, and beta is the sum
 * of the three (a Dimson beta); correlation is that beta times the benchmark's volatility over the return's.
 */
export function benchmarkRiskOf(series: ReturnPoint[], benchmark: ReturnPoint[], today?: string): BenchmarkRisk | undefined {
  const theirs = new Map(settled(stretchesOf(benchmark), today).map((stretch) => [stretch.date, stretch]));
  const pairs = settled(stretchesOf(series), today).flatMap((stretch) => {
    const other = theirs.get(stretch.date);
    return other && other.from === stretch.from ? [{ ours: stretch, theirs: other }] : [];
  });
  if (pairs.length < MIN_STRETCHES) return undefined;
  const ours = perDay(pairs.map((pair) => pair.ours));
  const bench = perDay(pairs.map((pair) => pair.theirs));
  if (!(bench.variance > 0) || !(ours.variance > 0)) return undefined;
  type Pair = (typeof pairs)[number];
  const move = (pair: Pair) => pair.theirs.log - bench.mean * pair.theirs.days;
  // Each stretch with a stretch on either side, weighted by its weekdays as for the variance.
  const rows = pairs.flatMap((pair, index) => {
    const before = pairs[index - 1], after = pairs[index + 1];
    return before && after && before.ours.date === pair.ours.from && after.ours.from === pair.ours.date
      ? [{ target: pair.ours.log - ours.mean * pair.ours.days, inputs: [move(before), move(pair), move(after)], weight: 1 / pair.ours.days }]
      : [];
  });
  const fit = rows.length >= MIN_STRETCHES ? leastSquares(rows) : undefined;
  if (!fit) return undefined;
  const beta = fit.reduce((sum, value) => sum + value, 0);
  return {
    volatility: round(Math.sqrt(bench.variance * WEEKDAYS_A_YEAR)),
    beta: round(beta, 2),
    correlation: round(Math.max(-1, Math.min(1, beta * Math.sqrt(bench.variance / ours.variance))), 2),
  };
}
