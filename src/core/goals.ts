// The account's investment goal, one per account, kept by TradePilot: Trading 212 has none. Saving one reads nothing.

import type { TradingEnvironment } from "../shared/contracts.js";
import { DEFAULT_GOAL_RETURN, DEFAULT_GOAL_VOLATILITY, MAX_GOAL_YEARS, type InvestmentGoal } from "../shared/goal.js";
import { requireCredentials, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { StateStore } from "./state-store.js";

const goalKey = (environment: TradingEnvironment) => `goal:${environment}`;

export interface GoalInput {
  environment: TradingEnvironment;
  target: number;
  by: string;
  monthly?: number;
  expectedReturn?: number;
  volatility?: number;
  name?: string;
  currency?: string;
}

export class Goals {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore }) {}

  get(environment: TradingEnvironment): Promise<InvestmentGoal | undefined> {
    return this.deps.store.get<InvestmentGoal>(goalKey(environment));
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
    if (!(monthly >= 0) || !Number.isFinite(monthly)) fail("INVALID_INPUT", "The monthly amount is 0 or more", { field: "monthly" });
    if (!(expectedReturn >= -0.5 && expectedReturn <= 0.3)) fail("INVALID_INPUT", "The yearly return is between -50% and 30%, as a fraction", { field: "expectedReturn" });
    if (!(volatility >= 0 && volatility <= 1)) fail("INVALID_INPUT", "The yearly volatility is between 0 and 100%, as a fraction", { field: "volatility" });
    const name = input.name === undefined ? current?.name : input.name.trim().slice(0, 80) || undefined;
    const currency = input.currency ?? current?.currency;
    const goal: InvestmentGoal = {
      environment: input.environment, target: input.target, by: input.by, monthly, expectedReturn, volatility,
      ...(currency ? { currency } : {}), ...(name ? { name } : {}),
      createdAt: current?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.deps.store.put(goalKey(input.environment), goal);
    return goal;
  }

  async remove(environment: TradingEnvironment): Promise<boolean> {
    const had = !!(await this.get(environment));
    await this.deps.store.delete(goalKey(environment));
    return had;
  }
}
