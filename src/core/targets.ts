// Saved target weights per environment. The scheduler compares them with the account about once an
// hour and, while a holding or cash is further from its target than the threshold, notifies once a
// day. Targets only inform: they never place orders. A rebalance from them is a basket the user confirms.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { TargetAllocation } from "../shared/automation.js";
import type { AllocationAnalysis, AllocationDrift } from "../shared/history.js";
import { DEFAULT_FX_FEE_RATE, knownCurrency, rebalanceEstimate } from "../shared/trade-cost.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import { MAX_BASKET_LEGS, resolveInstrumentFromList, type TradingService } from "./trading-service.js";

export const DEFAULT_DRIFT_THRESHOLD = 0.05;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const targetKey = (environment: TradingEnvironment) => `targets:${environment}`;
const share = (value: number) => Math.round(value * 10_000) / 10_000;
// Weights and drift keep six places so the widget rounds them once, as it does the other weights.
const exact = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export interface TargetInput {
  targets: Array<{ instrument: string; weight: number }>;
  cashWeight?: number;
  driftThreshold?: number;
  sellUntargeted?: boolean;
}

export interface DriftOptions {
  /** An instrument's quote currency, for the targets not held; the holdings carry theirs. */
  currencyOf?: (ticker: string) => string | undefined;
  /** Trading 212's currency conversion fee, for the estimate of what a rebalance converts (default 0.15%). */
  fxFeeRate?: number;
}

/**
 * Current weights against the saved targets. Drift is in weight points of total account value. With the account's
 * value and currency, also what a rebalance to the targets would trade, its buys fitted to the cash.
 */
export function allocationDrift(saved: TargetAllocation, analysis: Pick<AllocationAnalysis, "holdings" | "cashWeight"> & Partial<Pick<AllocationAnalysis, "totalValue" | "accountCurrency" | "cash" | "availableCash">>, options: DriftOptions = {}): AllocationDrift {
  const current = new Map(analysis.holdings.map((holding) => [holding.ticker, holding.weight]));
  const currencies = new Map(analysis.holdings.map((holding) => [holding.ticker, holding.currency]));
  const currencyOf = (ticker: string) => knownCurrency(currencies.get(ticker)) ?? knownCurrency(options.currencyOf?.(ticker));
  const rows = saved.targets
    .map((target) => {
      const weight = current.get(target.ticker) ?? 0;
      const currency = currencyOf(target.ticker);
      return { ticker: target.ticker, target: target.weight, current: exact(weight), drift: exact(weight - target.weight), ...(currency ? { currency } : {}) };
    })
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  const targeted = new Set(saved.targets.map((target) => target.ticker));
  const cash = { target: saved.cashWeight, current: exact(analysis.cashWeight), drift: exact(analysis.cashWeight - saved.cashWeight) };
  const untargeted = analysis.holdings.filter((holding) => !targeted.has(holding.ticker)).map((holding) => ({ ticker: holding.ticker, current: exact(holding.weight) }));
  // Holdings without a target only count when the targets say to sell them; otherwise they are kept as they are.
  const maxDrift = Math.max(Math.abs(cash.drift), ...rows.map((row) => Math.abs(row.drift)), ...(saved.sellUntargeted ? untargeted.map((item) => item.current) : []));
  const { totalValue, accountCurrency } = analysis;
  // The buys a rebalance can pay for: the cash free to trade above the cash target, and what the sells raise.
  const freeCash = analysis.availableCash ?? analysis.cash;
  const rebalance = totalValue && totalValue > 0 && accountCurrency
    ? rebalanceEstimate([
        ...rows,
        ...(saved.sellUntargeted ? untargeted.map((item) => ({ ...item, target: 0, ...(currencyOf(item.ticker) ? { currency: currencyOf(item.ticker)! } : {}) })) : []),
      ], totalValue, accountCurrency, options.fxFeeRate ?? DEFAULT_FX_FEE_RATE, freeCash === undefined ? undefined : freeCash - saved.cashWeight * totalValue)
    : undefined;
  return {
    threshold: saved.driftThreshold,
    maxDrift: exact(maxDrift),
    over: maxDrift > saved.driftThreshold + 1e-9,
    rows,
    cash,
    untargeted,
    ...(saved.sellUntargeted ? { sellUntargeted: true } : {}),
    savedAt: saved.updatedAt,
    ...(rebalance ? { rebalance } : {}),
  };
}

/**
 * Split new money across targets so it closes the largest gaps first. Each target's goal is its share
 * (of the target weights) of the targeted value after the contribution; the money goes to the targets
 * below their goal in proportion to how far below they are. Nothing is sold. Values and the result are
 * in the account currency; amounts are rounded down to cents.
 */
export function contributionSplit(targets: Array<{ ticker: string; weight: number }>, values: ReadonlyMap<string, number>, amount: number): Array<{ ticker: string; amount: number }> {
  const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
  if (!(totalWeight > 0) || !(amount > 0)) return [];
  const after = targets.reduce((sum, target) => sum + Math.max(0, values.get(target.ticker) ?? 0), 0) + amount;
  const gaps = targets.map((target) => ({ ticker: target.ticker, gap: Math.max(0, (target.weight / totalWeight) * after - Math.max(0, values.get(target.ticker) ?? 0)) }));
  // The gaps add up to at least the amount, because the goals add up to everything held plus the amount.
  const totalGap = gaps.reduce((sum, item) => sum + item.gap, 0);
  if (!(totalGap > 0)) return [];
  return gaps
    .map((item) => ({ ticker: item.ticker, amount: Math.floor((amount * item.gap / totalGap) * 100 + 1e-6) / 100 }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/** One sentence naming the largest drift, for notifications and flags. */
export function driftSummary(drift: AllocationDrift): string {
  const points = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} points`;
  const largest = drift.rows[0];
  const lead = largest && Math.abs(largest.drift) >= Math.abs(drift.cash.drift)
    ? `${largest.ticker} is ${(largest.current * 100).toFixed(1)}% against a ${(largest.target * 100).toFixed(1)}% target (${points(largest.drift)})`
    : `Cash is ${(drift.cash.current * 100).toFixed(1)}% against a ${(drift.cash.target * 100).toFixed(1)}% target (${points(drift.cash.drift)})`;
  return `${lead}; notices start above ${(drift.threshold * 100).toFixed(1)} points.`;
}

export class TargetAllocations {
  constructor(private readonly deps: {
    config: RuntimeConfig;
    store: StateStore;
    trading: TradingService;
    allocation: (environment: TradingEnvironment) => Promise<AllocationAnalysis>;
  }) {}

  get(environment: TradingEnvironment): Promise<TargetAllocation | undefined> {
    return this.deps.store.get<TargetAllocation>(targetKey(environment));
  }

  async set(environment: TradingEnvironment, input: TargetInput, now = new Date()): Promise<TargetAllocation> {
    requireCredentials(this.deps.config, environment);
    if (!input.targets.length || input.targets.length > MAX_BASKET_LEGS) fail("INVALID_INPUT", `Give between 1 and ${MAX_BASKET_LEGS} targets`, { field: "targets" });
    const instruments = await this.deps.trading.instruments(environment);
    const targets: TargetAllocation["targets"] = [];
    for (const target of input.targets) {
      if (!(target.weight > 0 && target.weight <= 1)) fail("INVALID_INPUT", "Each target weight must be above 0 and at most 1", { field: "weight", instrument: target.instrument });
      const ticker = resolveInstrumentFromList(instruments, target.instrument).ticker;
      if (targets.some((item) => item.ticker === ticker)) fail("INVALID_INPUT", `${ticker} is named more than once`, { field: "targets", ticker });
      const weight = share(target.weight);
      if (!(weight > 0)) fail("INVALID_INPUT", "Each target weight must be at least 0.0001 (0.01%)", { field: "weight", instrument: target.instrument });
      targets.push({ ticker, weight });
    }
    // The checks use the rounded weights that are stored, with the same tolerance as the rebalance planner.
    const invested = share(targets.reduce((sum, target) => sum + target.weight, 0));
    // Without a cash weight, whatever the targets leave over is meant to stay in cash.
    const cashWeight = share(input.cashWeight ?? Math.max(0, 1 - invested));
    if (invested + cashWeight > 1 + 1e-9) fail("INVALID_INPUT", `Targets (${(invested * 100).toFixed(2)}%) and cash (${(cashWeight * 100).toFixed(2)}%) add up to more than 100%`, { field: "targets" });
    const driftThreshold = input.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
    if (!(driftThreshold > 0 && driftThreshold < 1)) fail("INVALID_INPUT", "driftThreshold must be above 0 and below 1", { field: "driftThreshold" });
    const saved: TargetAllocation = { environment, targets, cashWeight, driftThreshold, ...(input.sellUntargeted ? { sellUntargeted: true } : {}), updatedAt: now.toISOString() };
    await this.deps.store.put(targetKey(environment), saved);
    return saved;
  }

  async clear(environment: TradingEnvironment): Promise<boolean> {
    const existed = !!(await this.get(environment));
    await this.deps.store.delete(targetKey(environment));
    return existed;
  }

  /** The analysis with its drift and, when over the threshold, a flag. */
  async withDrift(analysis: AllocationAnalysis): Promise<AllocationAnalysis> {
    const saved = await this.get(analysis.environment);
    if (!saved) return analysis;
    // The currencies of the targets not held, for what converting them costs; without the list they count as converted.
    const held = new Set(analysis.holdings.map((holding) => holding.ticker));
    const instruments = saved.targets.some((target) => !held.has(target.ticker)) ? await this.deps.trading.instruments(analysis.environment).catch(() => undefined) : undefined;
    const currencies = new Map((instruments ?? []).map((item) => [item.ticker, item.currencyCode]));
    const drift = allocationDrift(saved, analysis, { currencyOf: (ticker) => currencies.get(ticker), fxFeeRate: this.deps.config.fxFeeRate });
    return {
      ...analysis,
      drift,
      flags: drift.over ? [...analysis.flags, { code: "DRIFT_OVER_THRESHOLD", message: driftSummary(drift) }] : analysis.flags,
    };
  }

  /**
   * One scheduler tick: about once an hour per environment, compare the account with its targets and,
   * while the drift is over the threshold, record an allocation_drift event at most once a day.
   */
  async check(now = new Date()): Promise<Array<{ environment: TradingEnvironment; maxDrift: number; notified: boolean }>> {
    const credentials = credentialStatus(this.deps.config);
    const reports: Array<{ environment: TradingEnvironment; maxDrift: number; notified: boolean }> = [];
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      const saved = await this.get(environment);
      if (!saved) continue;
      const slot = await this.deps.store.increment(`drift-check:${environment}`, HOUR_MS, now.getTime());
      if (slot.count > 1) continue;
      const drift = allocationDrift(saved, await this.deps.allocation(environment));
      const due = drift.over && (!saved.lastNotifiedAt || now.getTime() - Date.parse(saved.lastNotifiedAt) >= DAY_MS);
      if (due) {
        // Re-read so a change saved while the account was read is kept.
        const current = await this.get(environment);
        if (!current || current.updatedAt !== saved.updatedAt) continue;
        await this.deps.store.put(targetKey(environment), { ...current, lastNotifiedAt: now.toISOString() });
        await this.deps.trading.recordActivity("allocation_drift", environment, { outcome: driftSummary(drift).slice(0, 200) });
      }
      reports.push({ environment, maxDrift: drift.maxDrift, notified: due });
    }
    return reports;
  }
}
