// Where the holdings' risk is: each holding's share of the portfolio's volatility beside its share of the value, read
// from a year of weekly closes. Weekly returns keep markets that close at different hours and on different holidays
// in step, which daily ones do not (a London close is hours before a New York one). They are in each instrument's own
// currency, so currency moves are not in them.

import { drawdownOf } from "./drawdown.js";
import type { AllocationAnalysis, HoldingCovariance, HoldingMix, HoldingRisk, HoldingRiskRow, MarketSensitivity, ReturnPoint, TargetVolatility } from "./history.js";
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
/** A bad week is one as bad as one week in this many: the worst 5%. */
const BAD_WEEK_ONE_IN = 20;
/**
 * A holding that moved less than this a year (cash, a money-market fund) keeps its weight in the equal-risk weights:
 * left in, it would take most of the rest, as it takes so much of it to add as much risk as a share does.
 */
export const PARITY_MIN_VOLATILITY = 0.02;
/** Rounds of the equal-risk search at most, and the change in a round below which it has settled. */
const PARITY_ROUNDS = 1000;
const PARITY_SETTLED = 1e-12;
/** The equal-risk weights are kept only when every holding's share of the risk is within this of the others'. */
const PARITY_SPREAD = 1e-6;
/** A rebalance plans this many targets at most (the basket's legs). */
export const MAX_PARITY_TARGETS = 20;

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
 * together, are left, or nothing moved. `onCovariance` is handed the holdings measured and their covariance a year,
 * which is not in the result: it is long, and the volatility at any weights is worked out from it (riskAtWeights).
 * `alongside` are instruments not held, for targets that would buy them: they are in the covariance, after the
 * holdings, when they have a close in each of the holdings' weeks and their closes do not jump, and are named in its
 * `unmeasured` otherwise; they change nothing in the result. `market` is the benchmark, which gives `market` (marketOf).
 */
export function holdingRiskOf(inputs: HoldingRiskInput[], today: string, totalValue?: number, onCovariance?: (covariance: HoldingCovariance) => void,
  alongside: ReadonlyArray<Pick<HoldingRiskInput, "ticker" | "points">> = [], market?: Pick<HoldingRiskInput, "ticker" | "points">): (HoldingRisk & { mix: HoldingMix }) | undefined {
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
  const weeklyReturns = (weeks: WeeklyInput["weeks"]) => common.slice(1).map((week, index) => {
    const before = common[index]!;
    return Math.log(weeks.get(week)!.close / weeks.get(before)!.close) / Math.sqrt((week - before) / 7);
  });
  const returns = measured.map((input) => weeklyReturns(input.weeks));
  // The instruments not held, over the holdings' weeks; one missing a week, or jumping, is left out.
  const held = new Set(inputs.map((input) => input.ticker));
  const besides = [...new Map(alongside.filter((input) => !held.has(input.ticker)).map((input) => [input.ticker, weeklyCloses(input.points, today)]))];
  const unmeasured: NonNullable<HoldingCovariance["unmeasured"]> = [];
  const beside: Array<{ ticker: string; returns: number[] }> = [];
  for (const [ticker, weeks] of besides) {
    if (jumps(weeks)) unmeasured.push({ ticker, reason: "jumps" });
    else if (!common.every((week) => weeks.has(week))) unmeasured.push({ ticker, reason: "short" });
    else beside.push({ ticker, returns: weeklyReturns(weeks) });
  }
  const n = common.length - 1;
  const series = [...returns, ...beside.map((input) => input.returns)];
  const means = series.map((values) => values.reduce((sum, value) => sum + value, 0) / n);
  const all = series.map((a, i) => series.map((b, j) => a.reduce((sum, value, k) => sum + (value - means[i]!) * (b[k]! - means[j]!), 0) / (n - 1) * WEEKS_A_YEAR));
  // The holdings' own: the instruments not held are only for the covariance handed on.
  const covariance = all.slice(0, measured.length).map((row) => row.slice(0, measured.length));
  const value = measured.reduce((sum, input) => sum + input.value, 0);
  const weights = measured.map((input) => input.value / value);
  // Each holding's covariance with the portfolio, and the portfolio's variance.
  const withPortfolio = covariance.map((row) => row.reduce((sum, cell, j) => sum + cell * weights[j]!, 0));
  const variance = withPortfolio.reduce((sum, cell, i) => sum + cell * weights[i]!, 0);
  if (!(variance > FLAT_VARIANCE)) return undefined;
  const volatility = Math.sqrt(variance);
  const own = covariance.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  const parity = parityOf(solvedOn(covariance, returns, means, own), weights, own);
  const rows: HoldingRiskRow[] = measured.map((input, i) => ({
    ticker: input.ticker,
    weight: round(weights[i]!),
    volatility: round(own[i]!),
    risk: round(weights[i]! * withPortfolio[i]! / variance),
    correlation: own[i]! > 0 ? round(Math.max(-1, Math.min(1, withPortfolio[i]! / (own[i]! * volatility)))) : 0,
    ...(parity ? { parity: round(parity[i]!) } : {}),
  })).sort((a, b) => b.risk - a.risk || b.weight - a.weight);
  const largest = measured.map((input, i) => ({ ticker: input.ticker, i, value: input.value }))
    .sort((a, b) => b.value - a.value).slice(0, MATRIX_SIZE);
  const correlation = (i: number, j: number) => (i === j ? 1 : own[i]! > 0 && own[j]! > 0 ? round(Math.max(-1, Math.min(1, covariance[i]![j]! / (own[i]! * own[j]!))), 4) : 0);
  // A week is dated by the latest of the holdings' last closes in it.
  const dateOf = (week: number) => measured.map((input) => input.weeks.get(week)!.date).sort().at(-1)!;
  onCovariance?.({ tickers: [...measured.map((input) => input.ticker), ...beside.map((input) => input.ticker)], matrix: all, ...(unmeasured.length ? { unmeasured } : {}) });
  const sensitivity = market && marketOf(measured, weights, common, market, today);
  return {
    from: dateOf(common[0]!),
    to: dateOf(common[n]!),
    weeks: n,
    volatility: round(volatility),
    diversification: round(measured.reduce((sum, _, i) => sum + weights[i]! * own[i]!, 0) / volatility, 4),
    covered: round(value / total, 4),
    rows,
    correlations: { tickers: largest.map((entry) => entry.ticker), matrix: largest.map((a) => largest.map((b) => correlation(a.i, b.i))) },
    ...(short.length ? { short } : {}),
    ...(jumped.length ? { jumps: jumped.map((input) => input.ticker) } : {}),
    mix: mixOf(measured, weights, common, dateOf, value),
    ...(parity ? { parityVolatility: round(Math.sqrt(Math.max(0, quadratic(covariance, parity)))) } : {}),
    ...(sensitivity ? { market: sensitivity } : {}),
  };
}

/**
 * Each holding measured against the benchmark: over the holdings' weeks that the benchmark has a close in too, its
 * beta (its covariance with the benchmark over the benchmark's variance) and correlation, from weekly log returns, a
 * gap of whole weeks scaled as in holdingRiskOf; the holdings together are their weights times their betas. Undefined
 * when the benchmark's closes jump, it does not move, or no more than MIN_WEEKS returns are left.
 */
function marketOf(measured: WeeklyInput[], weights: number[], common: number[], market: Pick<HoldingRiskInput, "ticker" | "points">, today: string): MarketSensitivity | undefined {
  const closes = weeklyCloses(market.points, today);
  if (jumps(closes)) return undefined;
  const weeks = common.filter((week) => closes.has(week));
  if (weeks.length - 1 <= MIN_WEEKS) return undefined;
  const scale = (week: number, before: number) => Math.sqrt((week - before) / 7);
  const logReturns = (at: (week: number) => number) => weeks.slice(1).map((week, index) => Math.log(at(week) / at(weeks[index]!)) / scale(week, weeks[index]!));
  const benchmark = logReturns((week) => closes.get(week)!.close);
  const holdings = measured.map((input) => logReturns((week) => input.weeks.get(week)!.close));
  // The holdings together: their weights' log returns, as their covariance is read.
  const mix = benchmark.map((_, k) => holdings.reduce((sum, series, i) => sum + weights[i]! * series[k]!, 0));
  const n = benchmark.length;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / n;
  const covarianceOf = (a: number[], b: number[]) => { const ma = mean(a); const mb = mean(b); return a.reduce((sum, value, k) => sum + (value - ma) * (b[k]! - mb), 0) / (n - 1); };
  const variance = covarianceOf(benchmark, benchmark);
  if (!(variance * WEEKS_A_YEAR > FLAT_VARIANCE)) return undefined;
  const sd = Math.sqrt(variance);
  const correlationWith = (series: number[]) => { const own = Math.sqrt(covarianceOf(series, series)); return own > 0 ? Math.max(-1, Math.min(1, covarianceOf(series, benchmark) / (own * sd))) : 0; };
  const rows = measured.map((input, i) => ({ ticker: input.ticker, weight: round(weights[i]!), beta: round(covarianceOf(holdings[i]!, benchmark) / variance, 4), correlation: round(correlationWith(holdings[i]!), 4) }))
    .sort((a, b) => b.beta - a.beta || b.weight - a.weight);
  // The benchmark's worst single week, and the holdings' simple return, at today's weights, that week.
  let worst: MarketSensitivity["worstWeek"];
  weeks.slice(1).forEach((week, index) => {
    const before = weeks[index]!;
    if (week - before !== 7) return;
    const move = closes.get(week)!.close / closes.get(before)!.close - 1;
    if (worst && move >= worst.market) return;
    const together = measured.reduce((sum, input, i) => sum + weights[i]! * (input.weeks.get(week)!.close / input.weeks.get(before)!.close - 1), 0);
    worst = { date: closes.get(week)!.date, market: round(move), mix: round(together) };
  });
  return {
    ticker: market.ticker,
    from: closes.get(weeks[0]!)!.date,
    to: closes.get(weeks.at(-1)!)!.date,
    weeks: n,
    volatility: round(sd * Math.sqrt(WEEKS_A_YEAR)),
    beta: round(weights.reduce((sum, weight, i) => sum + weight * covarianceOf(holdings[i]!, benchmark) / variance, 0), 4),
    correlation: round(correlationWith(mix), 4),
    rows,
    ...(worst ? { worstWeek: worst } : {}),
  };
}

/**
 * The weekly covariance pulled toward one in which every pair has the average correlation, by as much as the weeks
 * leave the pairs' own correlations in doubt (Ledoit and Wolf's constant-correlation shrinkage, 2004): with few weeks
 * for many holdings, much of what the sample says of a pair is noise, and weights solved on it would chase that noise.
 * Each holding's own variance is kept. A year's, as the sample covariance is given.
 */
function shrunkCovariance(returns: number[][], means: number[]): number[][] {
  const n = returns.length;
  const weeks = returns[0]!.length;
  const centred = returns.map((series, i) => series.map((value) => value - means[i]!));
  const sample = centred.map((a) => centred.map((b) => a.reduce((sum, value, t) => sum + value * b[t]!, 0) / weeks));
  const yearly = (matrix: number[][]) => matrix.map((row) => row.map((cell) => cell * weeks / (weeks - 1) * WEEKS_A_YEAR));
  const sd = sample.map((row, i) => Math.sqrt(row[i]!));
  if (sd.some((value) => !(value > 0))) return yearly(sample);
  let pairs = 0;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) pairs += sample[i]![j]! / (sd[i]! * sd[j]!);
  const average = pairs / (n * (n - 1) / 2);
  const target = sample.map((row, i) => row.map((cell, j) => (i === j ? cell : average * sd[i]! * sd[j]!)));
  // How far each cross product strays from its mean, week by week: the doubt in the sample.
  const stray = (i: number, j: number, t: number) => centred[i]![t]! * centred[j]![t]! - sample[i]![j]!;
  let doubt = 0;
  let shared = 0;
  let apart = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let square = 0;
      let withI = 0;
      let withJ = 0;
      for (let t = 0; t < weeks; t += 1) {
        const cross = stray(i, j, t);
        square += cross * cross;
        withI += stray(i, i, t) * cross;
        withJ += stray(j, j, t) * cross;
      }
      doubt += square / weeks;
      if (i === j) shared += square / weeks;
      else shared += average / 2 * (sd[j]! / sd[i]! * withI / weeks + sd[i]! / sd[j]! * withJ / weeks);
      apart += (target[i]![j]! - sample[i]![j]!) ** 2;
    }
  }
  const weight = apart > 0 ? Math.max(0, Math.min(1, (doubt - shared) / apart / weeks)) : 1;
  return yearly(sample.map((row, i) => row.map((cell, j) => weight * target[i]![j]! + (1 - weight) * cell)));
}

/**
 * The covariance the equal-risk weights are solved on: the holdings that move shrunk among themselves, so a quiet
 * holding (which keeps its weight) neither stops the shrinking nor pulls the average correlation down.
 */
function solvedOn(covariance: number[][], returns: number[][], means: number[], own: number[]): number[][] {
  const moving = own.flatMap((volatility, i) => (volatility >= PARITY_MIN_VOLATILITY ? [i] : []));
  if (moving.length < 2) return covariance;
  const shrunk = shrunkCovariance(moving.map((i) => returns[i]!), moving.map((i) => means[i]!));
  const at = new Map(moving.map((i, k) => [i, k]));
  return covariance.map((row, i) => row.map((cell, j) => (at.has(i) && at.has(j) ? shrunk[at.get(i)!]![at.get(j)!]! : cell)));
}

/** x'Σx: the variance a year of weights x. */
const quadratic = (covariance: number[][], x: number[]) =>
  covariance.reduce((sum, row, i) => sum + x[i]! * row.reduce((inner, cell, j) => inner + cell * x[j]!, 0), 0);

/**
 * The equal-risk weights: those at which each holding adds the same to the variance, x_i(Σx)_i alike for every i.
 * They minimise ½x'Σx − Σ ln(x_i)/n, which is searched one holding at a time: each x_i is the positive root of
 * Σ_ii x_i² + c_i x_i − 1/n = 0, c_i being Σ_ij x_j over the others, until no x_i moves; then they are scaled to sum to
 * 1. A holding that moved less than PARITY_MIN_VOLATILITY keeps its weight, and the others share the rest. Undefined
 * when fewer than two holdings move, or the search does not settle on equal shares (weeks too few for the holdings).
 */
export function parityOf(covariance: number[][], weights: number[], own: number[]): number[] | undefined {
  const moving = own.flatMap((volatility, i) => (volatility >= PARITY_MIN_VOLATILITY ? [i] : []));
  if (moving.length < 2) return undefined;
  const sigma = moving.map((i) => moving.map((j) => covariance[i]![j]!));
  const n = moving.length;
  const target = 1 / n;
  // From inverse volatilities: the answer when the holdings do not move together.
  const x = moving.map((i) => 1 / own[i]!);
  for (let round = 0; round < PARITY_ROUNDS; round += 1) {
    let moved = 0;
    for (let i = 0; i < n; i += 1) {
      const a = sigma[i]![i]!;
      const c = sigma[i]!.reduce((sum, cell, j) => (j === i ? sum : sum + cell * x[j]!), 0);
      const root = Math.sqrt(c * c + 4 * a * target);
      // The same root, written either way so as not to subtract two near numbers.
      const next = c >= 0 ? 2 * target / (c + root) : (root - c) / (2 * a);
      moved = Math.max(moved, Math.abs(next - x[i]!) / next);
      x[i] = next;
    }
    if (!Number.isFinite(moved)) return undefined;
    if (moved < PARITY_SETTLED) break;
  }
  const shares = x.map((value, i) => value * sigma[i]!.reduce((sum, cell, j) => sum + cell * x[j]!, 0));
  if (!shares.every((share) => share > 0 && Number.isFinite(share))) return undefined;
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (shares.some((share) => Math.abs(share / total - target) > PARITY_SPREAD)) return undefined;
  const kept = weights.reduce((sum, weight, i) => (moving.includes(i) ? sum : sum + weight), 0);
  const sum = x.reduce((all, value) => all + value, 0);
  const parity = [...weights];
  moving.forEach((i, k) => { parity[i] = (1 - kept) * x[k]! / sum; });
  return parity;
}

/**
 * Weights more than this over the account (0.05 points) are not a whole account: targets, the holdings kept beside
 * them and the cash target come to more than it, so a rebalance cannot reach them all.
 */
export const OVER_ACCOUNT = 0.0005;

/** The holdings measured at some weights: their volatility a year together, and each one's share of it. */
export interface RiskAtWeights {
  /** Weighed among themselves. */
  volatility: number;
  /** The volatility the weights give as they are: the account's, when they are its shares and nothing else held moves. */
  scaled: number;
  /** What the holdings measured weigh together, as the weights were given. */
  weight: number;
  /** Each holding's share of their variance, by ticker; below 0 for one that offsets the rest. */
  shares: Map<string, number>;
}

/**
 * The holdings measured at `weights` (by ticker; a ticker not measured, or without a weight, counts as none). Undefined
 * when the holdings measured weigh nothing.
 */
export function riskAtWeights(covariance: HoldingCovariance, weights: ReadonlyMap<string, number>): RiskAtWeights | undefined {
  const x = covariance.tickers.map((ticker) => Math.max(0, weights.get(ticker) ?? 0));
  const weight = x.reduce((sum, value) => sum + value, 0);
  if (!(weight > 0) || !Number.isFinite(weight)) return undefined;
  const w = x.map((value) => value / weight);
  const withMix = covariance.matrix.map((row) => row.reduce((sum, cell, j) => sum + cell * w[j]!, 0));
  const variance = Math.max(0, withMix.reduce((sum, cell, i) => sum + cell * w[i]!, 0));
  const volatility = Math.sqrt(variance);
  return {
    volatility,
    scaled: volatility * weight,
    weight,
    shares: new Map(covariance.tickers.map((ticker, i) => [ticker, variance > 0 ? w[i]! * withMix[i]! / variance : 0])),
  };
}

/** The holdings measured today and at a set of targets, and what is left out. */
export interface TargetRisk {
  now: RiskAtWeights;
  atTargets: RiskAtWeights;
  /**
   * The account's volatility, cash counted as not moving, when every holding and target with a weight is measured and
   * at the targets they and the cash target come to no more than the account (with holdings kept beside the targets,
   * they can come to more).
   */
  account?: { now: number; atTargets: number };
  /** Holdings and targets with a weight, today or at the targets, that are not measured. */
  leftOut: string[];
}

/**
 * The holdings measured, today and at `targets` (shares of the account by ticker), with `cashWeight` the cash target:
 * a holding without a target keeps its weight today, or none when the targets sell the holdings without one.
 * Undefined when the holdings measured weigh nothing today or at the targets.
 */
export function targetRiskOf(covariance: HoldingCovariance, holdings: ReadonlyArray<{ ticker: string; weight: number }>,
  targets: ReadonlyMap<string, number>, sellUntargeted: boolean, cashWeight = 0): TargetRisk | undefined {
  const today = new Map(holdings.filter((holding) => holding.weight > 0).map((holding) => [holding.ticker, holding.weight]));
  const after = new Map<string, number>();
  for (const [ticker, weight] of today) after.set(ticker, targets.get(ticker) ?? (sellUntargeted ? 0 : weight));
  for (const [ticker, weight] of targets) if (!after.has(ticker)) after.set(ticker, weight);
  const now = riskAtWeights(covariance, today);
  const atTargets = riskAtWeights(covariance, after);
  if (!now || !atTargets) return undefined;
  const measured = new Set(covariance.tickers);
  const unmeasured = (weights: Map<string, number>) => [...weights].filter(([ticker, weight]) => weight > 0 && !measured.has(ticker)).map(([ticker]) => ticker);
  const leftOut = [...new Set([...unmeasured(today), ...unmeasured(after)])];
  const whole = !leftOut.length && atTargets.weight + Math.max(0, cashWeight) <= 1 + OVER_ACCOUNT;
  return { now, atTargets, ...(whole ? { account: { now: now.scaled, atTargets: atTargets.scaled } } : {}), leftOut };
}

/** The analysis with its drift's volatility at the targets, when both the targets and the covariance are there. */
export function withTargetVolatility<T extends Pick<AllocationAnalysis, "drift" | "holdings">>(analysis: T, covariance: HoldingCovariance | undefined): T {
  const { drift } = analysis;
  if (!drift || !covariance) return analysis;
  const risk = targetRiskOf(covariance, analysis.holdings, new Map(drift.rows.map((row) => [row.ticker, row.target])), !!drift.sellUntargeted, drift.cash.target);
  if (!risk) return analysis;
  const volatility: TargetVolatility = {
    now: round(risk.now.volatility),
    atTargets: round(risk.atTargets.volatility),
    ...(risk.account ? { account: { now: round(risk.account.now), atTargets: round(risk.account.atTargets) } } : {}),
    ...(risk.leftOut.length ? { leftOut: risk.leftOut } : {}),
  };
  return { ...analysis, drift: { ...drift, volatility } };
}

/** What equalRiskTargets gives plan_portfolio_rebalance, and what the plan sells. */
export interface EqualRiskPlan {
  /** Shares of the account's value. */
  targets: Array<{ ticker: string; weight: number }>;
  /** The share of the account's value in cash free to trade, kept, so the sells pay for the buys. */
  cashWeight: number;
  /** The share of the holdings measured the plan sells, and buys again. */
  sold: number;
  /** Only the MAX_PARITY_TARGETS furthest from their equal-risk weight move. */
  partial?: true;
}

/**
 * The targets, as shares of the account's value, that move the holdings measured to their equal-risk weights for
 * plan_portfolio_rebalance: the holdings measured keep their value together, and the holdings not measured and the
 * cash free to trade stay as they are (the cash weight keeps that cash, so the sells pay for the buys). With more
 * holdings measured than a basket takes, the MAX_PARITY_TARGETS furthest from their equal-risk weight move, keeping
 * their value together, and the others stay (`partial`). Undefined without equal-risk weights or an account value.
 */
export function equalRiskTargets(analysis: Pick<AllocationAnalysis, "risk" | "holdings" | "totalValue" | "cash" | "availableCash">): EqualRiskPlan | undefined {
  const rows = analysis.risk?.rows ?? [];
  if (rows.length < 2 || !rows.every((row) => row.parity !== undefined) || !(analysis.totalValue > 0)) return undefined;
  const values = new Map(analysis.holdings.map((holding) => [holding.ticker, holding.value]));
  const value = (row: HoldingRiskRow) => values.get(row.ticker) ?? 0;
  // A holding measured that is not among the holdings would be bought from nothing.
  if (!rows.every((row) => value(row) > 0)) return undefined;
  const measured = rows.reduce((sum, row) => sum + value(row), 0);
  const moved = [...rows].sort((a, b) => Math.abs(b.parity! - b.weight) - Math.abs(a.parity! - a.weight) || b.weight - a.weight)
    .slice(0, MAX_PARITY_TARGETS);
  // The holdings moved keep their value together, shared by their equal-risk weights.
  const now = moved.reduce((sum, row) => sum + value(row), 0);
  const then = moved.reduce((sum, row) => sum + row.parity!, 0);
  if (!(then > 0)) return undefined;
  const after = (row: HoldingRiskRow) => row.parity! / then * now;
  // Shares of the account's value, or of the holdings and the cash where, rounded, they come to more: floored, so
  // the targets and the cash weight never come to more than 1 (beyond the planner's 1e-9 for sums), which it refuses.
  const whole = Math.max(analysis.totalValue, analysis.holdings.reduce((sum, holding) => sum + Math.max(0, holding.value), 0) + Math.max(0, analysis.cash));
  const floor = (share: number) => Math.floor(share * 1e6) / 1e6;
  const targets = moved.map((row) => ({ ticker: row.ticker, weight: floor(after(row) / whole) }));
  const taken = targets.reduce((sum, target) => sum + target.weight, 0);
  // The planner spends only the cash free to trade, none without it.
  const cashWeight = Math.max(0, floor(Math.min((analysis.availableCash ?? 0) / whole, 1 - taken)));
  if (taken + cashWeight > 1 + 1e-9) return undefined;
  const sold = moved.reduce((sum, row) => sum + Math.max(0, value(row) - after(row)), 0) / measured;
  return { targets, cashWeight, sold: round(sold), ...(moved.length < rows.length ? { partial: true as const } : {}) };
}

/**
 * Today's mix kept at today's weights each week: its weekly returns, where it stood, its bad weeks and deepest fall.
 * A return across a week with no close for some holding runs on to the next close: it is in the line and the return,
 * but is not one week, so it is left out of the bad weeks, the worst and best, and the weeks up.
 */
function mixOf(measured: WeeklyInput[], weights: number[], common: number[], dateOf: (week: number) => string, value: number): HoldingMix {
  const steps = common.slice(1).map((week, index) => {
    const before = common[index]!;
    return { date: dateOf(week), weeks: (week - before) / 7, return: measured.reduce((sum, input, i) => sum + weights[i]! * (input.weeks.get(week)!.close / input.weeks.get(before)!.close - 1), 0) };
  });
  const single = steps.filter((step) => step.weeks === 1);
  // Never none: more than MIN_WEEKS returns over at most a year leave single weeks.
  const weekly: ReturnPoint[] = (single.length ? single : steps).map((step) => ({ date: step.date, return: step.return }));
  let level = 1;
  const series: ReturnPoint[] = [{ date: dateOf(common[0]!), return: 0 }, ...steps.map((point) => {
    level *= 1 + point.return;
    return { date: point.date, return: round(level - 1) };
  })];
  // Worst first; a tie keeps the earlier week.
  const sorted = [...weekly].sort((a, b) => a.return - b.return || a.date.localeCompare(b.date));
  const tail = sorted.slice(0, Math.ceil(weekly.length / BAD_WEEK_ONE_IN));
  const drawdown = drawdownOf(series);
  const point = (at: ReturnPoint) => ({ date: at.date, return: round(at.return) });
  return {
    value: round(value, 2),
    series,
    return: round(level - 1),
    badWeek: round(tail.at(-1)!.return),
    badWeeks: round(tail.reduce((sum, at) => sum + at.return, 0) / tail.length),
    worst: point(sorted[0]!),
    best: point(weekly.reduce((top, at) => (at.return > top.return ? at : top))),
    up: weekly.filter((at) => at.return > 0).length,
    counted: weekly.length,
    ...(drawdown ? { drawdown } : {}),
  };
}

/** The market falls the holdings' betas are read against: 5%, 10% and 20%. */
export const MARKET_FALLS = [-0.05, -0.1, -0.2] as const;

/** What a fall in the benchmark would take, by the holdings' betas: as a share of them, in money, and of the account. */
export interface MarketScenario {
  /** The benchmark's move. */
  market: number;
  /** The holdings measured, at their beta: beta times the move. */
  move: number;
  /** That of the value of the holdings measured, in the account currency. */
  amount: number;
  /** That of the account's value, cash counted as not moving; absent without it. */
  account?: number;
}

/**
 * The holdings measured in each of MARKET_FALLS, by their beta alone: what moves with the market, not what each does
 * on its own (a beta is an average over the weeks read, not a forecast). `value` is the holdings measured's value now.
 */
export function marketScenarios(beta: number, value: number, accountValue?: number): MarketScenario[] {
  return MARKET_FALLS.map((market) => {
    const move = round(beta * market);
    const amount = round(move * value, 2);
    return { market, move, amount, ...(accountValue && accountValue > 0 ? { account: round(amount / accountValue) } : {}) };
  });
}
