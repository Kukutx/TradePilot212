// The account's investment goal, one per account, kept by TradePilot: Trading 212 has none. Saving one reads nothing.
// Each hour the scheduler records the account value, and the goal is measured against it: when the value first
// reaches 25%, 50%, 75% or 100% of the target, a goal_milestone activity event says so (and goes to the webhook).
// The progress already made when a goal is set, or its target changed, is taken as known and not announced.

import type { TradingEnvironment } from "../shared/contracts.js";
import { DEFAULT_GOAL_INFLATION, DEFAULT_GOAL_RETURN, DEFAULT_GOAL_VOLATILITY, goalMilestone, MAX_GOAL_YEARS, type InvestmentGoal } from "../shared/goal.js";
import type { ValuePoint } from "../shared/history.js";
import { requireCredentials, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { NotifyLocale } from "./notify.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

const goalKey = (environment: TradingEnvironment) => `goal:${environment}`;
/**
 * The milestone reached, kept apart from the goal so the scheduler never writes the goal itself: a save or a removal
 * made while it checks cannot be overwritten. It belongs to the goal created at `createdAt` with this `target`.
 */
const milestoneKey = (environment: TradingEnvironment) => `goal-milestone:${environment}`;
interface MilestoneRecord { createdAt: string; target: number; mark: number }
const belongs = (record: MilestoneRecord | undefined, goal: InvestmentGoal) => !!record && record.createdAt === goal.createdAt && record.target === goal.target;

export interface GoalInput {
  environment: TradingEnvironment;
  target: number;
  by: string;
  monthly?: number;
  expectedReturn?: number;
  volatility?: number;
  inflation?: number;
  name?: string;
  currency?: string;
  /** The account value now, kept as the goal's start when it is new or its target changes. */
  value?: number;
}

export interface GoalReport {
  environment: TradingEnvironment;
  /** "seeded": first measured, nothing said; "reached": a new milestone; "none": no new one. */
  action: "seeded" | "reached" | "none";
  milestone: number;
  message: string;
}

const MILESTONE_WORDS = {
  en: (goal: string, mark: number, value: string, target: string, by: string) => mark >= 100
    ? `${goal} reached: ${value} against a target of ${target} by ${by}.`
    : `${goal} is ${mark}% of the way: ${value} of ${target} by ${by}.`,
  "zh-CN": (goal: string, mark: number, value: string, target: string, by: string) => mark >= 100
    ? `${goal}已达成：市值 ${value}，目标 ${target}，截止 ${by}。`
    : `${goal}已完成 ${mark}%：${value} / ${target}，截止 ${by}。`,
} as const;

/** What the scheduler says when a milestone is reached, in NOTIFY_LOCALE's language. */
export function milestoneText(goal: InvestmentGoal, mark: number, value: number, currency: string | undefined, locale: NotifyLocale = "en"): string {
  const money = (amount: number) => {
    const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount);
    return currency ? `${text} ${currency}` : text;
  };
  const name = goal.name ? (locale === "zh-CN" ? `目标「${goal.name}」` : `The goal "${goal.name}"`) : (locale === "zh-CN" ? "投资目标" : "The investment goal");
  return MILESTONE_WORDS[locale](name, mark, money(value), money(goal.target), goal.by);
}

export class Goals {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading?: Pick<TradingService, "recordActivity"> }) {}

  /** The goal with the milestone its target has reached, when the scheduler has measured it. */
  async get(environment: TradingEnvironment): Promise<InvestmentGoal | undefined> {
    const [goal, record] = await Promise.all([this.deps.store.get<InvestmentGoal>(goalKey(environment)), this.deps.store.get<MilestoneRecord>(milestoneKey(environment))]);
    if (!goal) return undefined;
    const { milestone: _stored, ...rest } = goal;
    return belongs(record, goal) ? { ...rest, milestone: record!.mark } : rest;
  }

  async set(input: GoalInput, now = new Date()): Promise<InvestmentGoal> {
    requireCredentials(this.deps.config, input.environment);
    if (!(input.target > 0) || !Number.isFinite(input.target)) fail("INVALID_INPUT", "The target is an amount above 0, in the account currency", { field: "target" });
    const by = new Date(`${input.by}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.by) || !Number.isFinite(by.getTime()) || by.toISOString().slice(0, 10) !== input.by) fail("INVALID_INPUT", "The date is YYYY-MM-DD", { field: "by" });
    if (by.getTime() <= now.getTime()) fail("INVALID_INPUT", "The date is in the future", { field: "by" });
    if (by.getUTCFullYear() - now.getUTCFullYear() > MAX_GOAL_YEARS) fail("INVALID_INPUT", `The date is at most ${MAX_GOAL_YEARS} years away`, { field: "by" });
    const current = await this.get(input.environment);
    const monthly = input.monthly ?? current?.monthly ?? 0;
    const expectedReturn = input.expectedReturn ?? current?.expectedReturn ?? DEFAULT_GOAL_RETURN;
    const volatility = input.volatility ?? current?.volatility ?? DEFAULT_GOAL_VOLATILITY;
    // A goal saved before inflation was asked for assumed none.
    const inflation = input.inflation ?? (current ? current.inflation ?? 0 : DEFAULT_GOAL_INFLATION);
    if (!(monthly >= 0) || !Number.isFinite(monthly)) fail("INVALID_INPUT", "The monthly amount is 0 or more", { field: "monthly" });
    if (!(expectedReturn >= -0.5 && expectedReturn <= 0.3)) fail("INVALID_INPUT", "The yearly return is between -50% and 30%, as a fraction", { field: "expectedReturn" });
    if (!(volatility >= 0 && volatility <= 1)) fail("INVALID_INPUT", "The yearly volatility is between 0 and 100%, as a fraction", { field: "volatility" });
    if (!(inflation >= 0 && inflation <= 0.2)) fail("INVALID_INPUT", "The yearly inflation is between 0 and 20%, as a fraction", { field: "inflation" });
    const name = input.name === undefined ? current?.name : input.name.trim().slice(0, 80) || undefined;
    const currency = input.currency ?? current?.currency;
    // The pace is measured from where the account stood when this target was set.
    const sameTarget = !!current && current.target === input.target;
    const start = sameTarget && current.start ? current.start : input.value !== undefined && Number.isFinite(input.value) ? { value: input.value, at: now.toISOString() } : undefined;
    const goal: InvestmentGoal = {
      environment: input.environment, target: input.target, by: input.by, monthly, expectedReturn, volatility, inflation,
      ...(currency ? { currency } : {}), ...(name ? { name } : {}), ...(start ? { start } : {}),
      createdAt: current?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.deps.store.put(goalKey(input.environment), goal);
    // The milestone of the same target carries over; a new target is measured afresh at the next check.
    return current?.milestone !== undefined && current.target === goal.target ? { ...goal, milestone: current.milestone } : goal;
  }

  async remove(environment: TradingEnvironment): Promise<boolean> {
    const had = !!(await this.get(environment));
    await this.deps.store.delete(goalKey(environment));
    await this.deps.store.delete(milestoneKey(environment));
    return had;
  }

  /**
   * Measure each account's goal against the value the scheduler just recorded for it. The first measure only notes the
   * milestone reached; after that, each higher one writes a goal_milestone event. A fall below a milestone is not
   * announced, and the milestone is kept, so a value that hovers around it is announced once.
   */
  async check(points: Array<{ environment: TradingEnvironment; point: ValuePoint }>): Promise<GoalReport[]> {
    const reports: GoalReport[] = [];
    for (const { environment, point } of points) {
      const goal = await this.get(environment);
      if (!goal) continue;
      const mark = goalMilestone(point.totalValue, goal.target);
      const known = goal.milestone;
      if (known !== undefined && mark <= known) {
        reports.push({ environment, action: "none", milestone: known, message: "No new milestone." });
        continue;
      }
      // Saved before the event, so a failed write cannot announce it twice. Only the milestone's own record is written:
      // a goal saved or removed meanwhile stays as it was saved, and a record left for a goal gone is never read.
      await this.deps.store.put(milestoneKey(environment), { createdAt: goal.createdAt, target: goal.target, mark } satisfies MilestoneRecord);
      if (known === undefined || !this.deps.trading) {
        reports.push({ environment, action: "seeded", milestone: mark, message: `Seeded at ${mark}%.` });
        continue;
      }
      const message = milestoneText(goal, mark, point.totalValue, goal.currency, this.deps.config.notifyLocale);
      await this.deps.trading.recordActivity("goal_milestone", environment, { outcome: message });
      reports.push({ environment, action: "reached", milestone: mark, message });
    }
    return reports;
  }
}
