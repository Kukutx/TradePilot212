// An investment goal: an amount to reach by a date, with what you add each month. The projection is a range, not a
// forecast: growth at an assumed yearly return and volatility, the low and high lines being the 10th and 90th
// percentiles of the yearly growth over each horizon (lognormal), with each month's contribution growing at the same
// rate. The server and the widget work it out the same way, so the form shows the range as it is typed.

import type { CredentialStatus, TradingEnvironment } from "./contracts.js";

export const DEFAULT_GOAL_RETURN = 0.06;
export const DEFAULT_GOAL_VOLATILITY = 0.15;
/** The furthest a goal may be, in years. */
export const MAX_GOAL_YEARS = 50;
/** The 90th percentile of the standard normal: the low and high lines are this many deviations either side. */
const Z90 = 1.2815515655446004;
/** The widest yearly log growth the chance looks for, either way: beyond it the target is out of reach (or certain). */
const BRACKET_LIMIT = 768;

export interface InvestmentGoal {
  environment: TradingEnvironment;
  /** The amount to reach, in the account currency. */
  target: number;
  /** The day to reach it by, YYYY-MM-DD. */
  by: string;
  /** Added each month, in the account currency; 0 for none. */
  monthly: number;
  /** The yearly return assumed, as a fraction (0.06 is 6%), before costs and inflation. */
  expectedReturn: number;
  /** The yearly volatility assumed, as a fraction. */
  volatility: number;
  /** The account currency when it was saved. */
  currency?: string;
  name?: string;
  /**
   * The highest milestone (25, 50, 75 or 100, in % of the target) the account value has reached since the goal was
   * set or its target changed; 0 for none. Absent until the scheduler has measured the goal once.
   */
  milestone?: number;
  createdAt: string;
  updatedAt: string;
}

/** The share of the target, in %, at which the scheduler says how far the account has come. */
export const GOAL_MILESTONES = [25, 50, 75, 100] as const;

/** The highest milestone a value has reached against a target: 0 below the first. */
export function goalMilestone(value: number, target: number): number {
  if (!(target > 0) || !Number.isFinite(value)) return 0;
  return GOAL_MILESTONES.filter((mark) => value >= (target * mark) / 100).at(-1) ?? 0;
}

export type GoalInputs = Pick<InvestmentGoal, "target" | "by" | "monthly" | "expectedReturn" | "volatility">;

export interface GoalPoint {
  /** The month's date, YYYY-MM-DD. */
  date: string;
  low: number;
  mid: number;
  high: number;
  /** The value now plus what was added by then, with no growth. */
  added: number;
}

export interface GoalProjection {
  /** Whole months from now to the goal's date. */
  months: number;
  /** One point a month, or a quarter beyond ten years, from now (the value now) to the goal's date. */
  points: GoalPoint[];
  final: { low: number; mid: number; high: number };
  /** What will have been added by the date, beyond the value now. */
  added: number;
  /** The chance, under the assumptions, of being at or above the target by the date. */
  chance: number;
  /** The monthly amount that reaches the target on the middle line: 0 when the value now gets there alone. */
  neededMonthly: number;
  /** The value now is at or above the target already. */
  reached: boolean;
}

/** The goal and the value it is measured against, as get_portfolio_performance and manage_goal return them. */
export interface GoalView {
  kind: "goal";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  goal?: InvestmentGoal;
  value?: number;
  currency?: string;
  projection?: GoalProjection;
  timestamp: string;
}

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, close to 1e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Whole months from `now` to `by`, counting a part month as one. */
export function monthsUntil(by: string, now: Date): number {
  const end = new Date(`${by}T00:00:00Z`);
  if (!Number.isFinite(end.getTime())) return 0;
  const months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12 + end.getUTCMonth() - now.getUTCMonth() + (end.getUTCDate() > now.getUTCDate() ? 1 : 0);
  return Math.max(0, months);
}

/** The value after `months` with a constant yearly log growth `growth`, adding `monthly` at each month's end. */
function grown(value: number, monthly: number, growth: number, months: number): number {
  const step = Math.exp(growth / 12);
  const lump = value * step ** months;
  // Sum of step^k for k = 0 … months - 1.
  const annuity = Math.abs(step - 1) < 1e-12 ? months : (step ** months - 1) / (step - 1);
  return lump + monthly * annuity;
}

export function projectGoal(inputs: GoalInputs, value: number, now = new Date()): GoalProjection {
  const months = monthsUntil(inputs.by, now);
  const sigma = Math.max(0, inputs.volatility);
  // The median yearly log growth: the expected return less the volatility drag.
  const median = Math.log(1 + Math.max(-0.99, inputs.expectedReturn)) - (sigma * sigma) / 2;
  const at = (m: number, z: number) => (m === 0 ? value : grown(value, inputs.monthly, median + z * sigma / Math.sqrt(m / 12), m));
  const step = months > 120 ? 3 : 1;
  const points: GoalPoint[] = [];
  const marks = new Set<number>([0, months]);
  for (let m = step; m < months; m += step) marks.add(m);
  for (const m of [...marks].sort((a, b) => a - b)) {
    const date = m === 0 ? isoDay(now) : m === months ? inputs.by : isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, Math.min(now.getUTCDate(), 28))));
    points.push({ date, low: at(m, -Z90), mid: at(m, 0), high: at(m, Z90), added: value + inputs.monthly * m });
  }
  const last = points[points.length - 1]!;
  const reached = value >= inputs.target;
  let chance: number;
  if (reached && inputs.monthly >= 0) chance = 1;
  else if (months === 0) chance = reached ? 1 : 0;
  else {
    // The yearly growth that just reaches the target, found by halving; the chance is of growing faster than it. Over a
    // month or two the growth needed can be far from ±3 a year and still likely, so the bracket widens until it holds it.
    let low = -3;
    let high = 3;
    while (high < BRACKET_LIMIT && grown(value, inputs.monthly, high, months) < inputs.target) high *= 2;
    while (low > -BRACKET_LIMIT && grown(value, inputs.monthly, low, months) >= inputs.target) low *= 2;
    if (grown(value, inputs.monthly, high, months) < inputs.target) chance = 0;
    else if (grown(value, inputs.monthly, low, months) >= inputs.target) chance = 1;
    else {
      for (let index = 0; index < 80; index++) {
        const middle = (low + high) / 2;
        if (grown(value, inputs.monthly, middle, months) >= inputs.target) high = middle; else low = middle;
      }
      chance = sigma > 0 ? 1 - normalCdf((high - median) / (sigma / Math.sqrt(months / 12))) : (high <= median ? 1 : 0);
    }
  }
  const lumpMid = months ? grown(value, 0, median, months) : value;
  const perMonth = months ? grown(0, 1, median, months) : 0;
  const neededMonthly = reached || lumpMid >= inputs.target || !perMonth ? 0 : (inputs.target - lumpMid) / perMonth;
  return {
    months, points,
    final: { low: last.low, mid: last.mid, high: last.high },
    added: inputs.monthly * months,
    chance: Math.min(1, Math.max(0, chance)),
    neededMonthly,
    reached,
  };
}
