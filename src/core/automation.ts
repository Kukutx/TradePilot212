// Standing plans (dollar-cost averaging) and the scheduler that runs them.
//
// Automation levels:
// - L2, every environment: a due plan is turned into a basket the user confirms in the widget.
// - L3, Demo only: with AUTOMATION_DEMO_ENABLED=true, a due Demo plan marked autoExecute is sent
//   without a person, through the same validation and policy checks as a confirmed basket.
// Live plans are never executed unattended; nothing in this file can change that per plan.

import type { OrderDraft, TradingEnvironment } from "../shared/contracts.js";
import type { BasketDraftPayload, BasketExecutionResult, DcaLeg, DcaPlan, PlanFrequency, PlanRunReport, TargetAllocation } from "../shared/automation.js";
import { positionValue } from "./analytics.js";
import { requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import { crossRate } from "./fx.js";
import type { StateStore } from "./state-store.js";
import { contributionSplit } from "./targets.js";
import { resolveInstrumentFromList, type BasketRequest, type TradingService } from "./trading-service.js";
import { randomToken } from "./web-utils.js";

export interface AutomationDeps {
  config: RuntimeConfig;
  store: StateStore;
  trading: TradingService;
  /** The saved target weights, for plans that invest across them. */
  targets?: (environment: TradingEnvironment) => Promise<TargetAllocation | undefined>;
}

export interface PlanInput {
  environment: TradingEnvironment;
  label: string;
  /** Fixed buys; leave empty and give targetAmount to invest across the saved targets instead. */
  legs: DcaLeg[];
  targetAmount?: number;
  frequency: PlanFrequency;
  dayOfMonth?: number;
  weekday?: number;
  hourUtc?: number;
  autoExecute?: boolean;
}

export interface PlanPatch {
  label?: string;
  /** Switches the plan to fixed buys. */
  legs?: DcaLeg[];
  /** Switches the plan to investing this amount across the saved targets. */
  targetAmount?: number;
  paused?: boolean;
  autoExecute?: boolean;
  frequency?: PlanFrequency;
  dayOfMonth?: number;
  weekday?: number;
  hourUtc?: number;
}

export const MAX_PLANS = 20;
export const MAX_PLAN_LEGS = 10;
const DEFAULT_HOUR_UTC = 15;
const RUN_LOCK_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const planKey = (id: string) => `plan:${id}`;
const floorTo = (value: number, digits: number) => Math.floor(value * 10 ** digits + 1e-9) / 10 ** digits;
/** Target splits below this, in the account currency, are left in cash rather than sent as a tiny order. */
export const MIN_TARGET_LEG = 1;

function validateTargetAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) fail("INVALID_INPUT", "targetAmount must be a positive amount in the account currency", { field: "targetAmount" });
}
export const DEFAULT_LIMIT_OFFSET_PERCENT = 0.5;
export const MAX_LIMIT_OFFSET_PERCENT = 10;

/** Limit price for a plan leg: the last price plus the offset, rounded to the price's usual tick. */
export function planLimitPrice(price: number, offsetPercent: number): number {
  const digits = price >= 1 ? 2 : 4;
  return Math.round(price * (1 + offsetPercent / 100) * 10 ** digits) / 10 ** digits;
}

/** The first due time strictly after `after`. */
export function nextRunAt(plan: Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hourUtc">, after: Date): Date {
  if (plan.frequency === "monthly") {
    const day = plan.dayOfMonth ?? 1;
    let candidate = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), day, plan.hourUtc));
    if (candidate <= after) candidate = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, day, plan.hourUtc));
    return candidate;
  }
  const weekday = plan.weekday ?? 1;
  const today = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), plan.hourUtc));
  const isoToday = today.getUTCDay() || 7;
  let candidate = new Date(today.getTime() + ((weekday - isoToday + 7) % 7) * DAY_MS);
  if (candidate <= after) candidate = new Date(candidate.getTime() + 7 * DAY_MS);
  return candidate;
}

/** The occurrence before `next` on the same schedule. */
function previousRunAt(plan: Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hourUtc">, next: Date): Date {
  if (plan.frequency === "monthly") return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() - 1, plan.dayOfMonth ?? 1, plan.hourUtc));
  return new Date(next.getTime() - 7 * DAY_MS);
}

/** The next due date from `now`, skipping the coming one when this period already ran. */
export function scheduleFrom(plan: Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hourUtc" | "lastRunAt">, now: Date): Date {
  const next = nextRunAt(plan, now);
  const lastRun = plan.lastRunAt ? Date.parse(plan.lastRunAt) : NaN;
  return Number.isFinite(lastRun) && lastRun > previousRunAt(plan, next).getTime() ? nextRunAt(plan, next) : next;
}

function validateSchedule(input: Pick<PlanInput, "frequency" | "dayOfMonth" | "weekday" | "hourUtc">) {
  if (input.frequency === "monthly" && (input.dayOfMonth === undefined || !Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 28))
    fail("INVALID_INPUT", "Monthly plans need dayOfMonth between 1 and 28", { field: "dayOfMonth" });
  if (input.frequency === "weekly" && (input.weekday === undefined || !Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7))
    fail("INVALID_INPUT", "Weekly plans need weekday between 1 (Monday) and 7 (Sunday)", { field: "weekday" });
  if (input.hourUtc !== undefined && (!Number.isInteger(input.hourUtc) || input.hourUtc < 0 || input.hourUtc > 23))
    fail("INVALID_INPUT", "hourUtc must be an integer from 0 to 23", { field: "hourUtc" });
}

function assertAutoExecuteAllowed(environment: TradingEnvironment, autoExecute: boolean | undefined) {
  if (autoExecute && environment !== "demo") fail("INVALID_INPUT", "Unattended execution is only available for Demo plans. Live plans always wait for your confirmation.", { field: "autoExecute" });
}

export class AutomationService {
  constructor(private readonly deps: AutomationDeps) {}

  async listPlans(environment?: TradingEnvironment): Promise<DcaPlan[]> {
    const entries = await this.deps.store.list<DcaPlan>("plan:");
    return entries
      .map((entry) => entry.value)
      .filter((plan) => !environment || plan.environment === environment)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async getPlan(id: string): Promise<DcaPlan> {
    const plan = await this.deps.store.get<DcaPlan>(planKey(id));
    if (!plan) fail("PLAN_NOT_FOUND", "Plan not found", { planId: id });
    return plan;
  }

  private async resolveLegs(environment: TradingEnvironment, legs: DcaLeg[]): Promise<DcaLeg[]> {
    if (!legs.length || legs.length > MAX_PLAN_LEGS) fail("INVALID_INPUT", `A plan needs 1 to ${MAX_PLAN_LEGS} legs`);
    const instruments = await this.deps.trading.instruments(environment);
    return legs.map((leg) => {
      if (!Number.isFinite(leg.amount) || leg.amount <= 0) fail("INVALID_INPUT", "Each plan leg needs a positive amount", { field: "amount" });
      const ticker = resolveInstrumentFromList(instruments, leg.ticker).ticker;
      if (leg.orderType !== "limit") return { ticker, amount: leg.amount };
      const offset = leg.limitOffsetPercent ?? DEFAULT_LIMIT_OFFSET_PERCENT;
      if (!Number.isFinite(offset) || offset < 0 || offset > MAX_LIMIT_OFFSET_PERCENT)
        fail("INVALID_INPUT", `limitOffsetPercent must be between 0 and ${MAX_LIMIT_OFFSET_PERCENT}`, { field: "limitOffsetPercent" });
      return { ticker, amount: leg.amount, orderType: "limit" as const, limitOffsetPercent: offset };
    });
  }

  async createPlan(input: PlanInput, now = new Date()): Promise<DcaPlan> {
    validateSchedule(input);
    assertAutoExecuteAllowed(input.environment, input.autoExecute);
    requireCredentials(this.deps.config, input.environment);
    if ((await this.listPlans()).length >= MAX_PLANS) fail("INVALID_INPUT", `At most ${MAX_PLANS} plans can be stored`);
    const byTargets = input.targetAmount !== undefined;
    if (byTargets && input.legs.length) fail("INVALID_INPUT", "Give either legs or targetAmount, not both", { field: "targetAmount" });
    if (byTargets) validateTargetAmount(input.targetAmount!);
    const schedule = {
      frequency: input.frequency,
      ...(input.frequency === "monthly" ? { dayOfMonth: input.dayOfMonth! } : { weekday: input.weekday! }),
      hourUtc: input.hourUtc ?? DEFAULT_HOUR_UTC,
    };
    const plan: DcaPlan = {
      id: `dca_${randomToken(12)}`,
      environment: input.environment,
      label: input.label.trim().slice(0, 80) || "DCA plan",
      legs: byTargets ? [] : await this.resolveLegs(input.environment, input.legs),
      ...(byTargets ? { targetAmount: input.targetAmount! } : {}),
      ...schedule,
      autoExecute: !!input.autoExecute,
      paused: false,
      nextRunAt: nextRunAt(schedule, now).toISOString(),
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(planKey(plan.id), plan);
    return plan;
  }

  async updatePlan(id: string, patch: PlanPatch, now = new Date()): Promise<DcaPlan> {
    const plan = await this.getPlan(id);
    assertAutoExecuteAllowed(plan.environment, patch.autoExecute);
    let base: DcaPlan = plan;
    if ([patch.frequency, patch.dayOfMonth, patch.weekday, patch.hourUtc].some((value) => value !== undefined)) {
      const frequency = patch.frequency ?? plan.frequency;
      const schedule = {
        frequency,
        ...(frequency === "monthly" ? { dayOfMonth: patch.dayOfMonth ?? plan.dayOfMonth } : { weekday: patch.weekday ?? plan.weekday }),
        hourUtc: patch.hourUtc ?? plan.hourUtc,
      };
      validateSchedule(schedule);
      // A new schedule starts from now; the old due date no longer applies. A period that already
      // ran is not run again just because its hour or day moved.
      const { dayOfMonth: _day, weekday: _weekday, ...rest } = plan;
      base = { ...rest, ...schedule, nextRunAt: scheduleFrom({ ...schedule, ...(plan.lastRunAt ? { lastRunAt: plan.lastRunAt } : {}) }, now).toISOString() };
    }
    if (patch.legs !== undefined && patch.targetAmount !== undefined) fail("INVALID_INPUT", "Give either legs or targetAmount, not both", { field: "targetAmount" });
    if (patch.targetAmount !== undefined) validateTargetAmount(patch.targetAmount);
    const legs = patch.legs === undefined ? undefined : await this.resolveLegs(plan.environment, patch.legs);
    // Unpausing schedules from now instead of firing a due date that passed while paused.
    const resumed = patch.paused === false && plan.paused && Date.parse(base.nextRunAt) <= now.getTime();
    // Re-read after the awaits above, so a run recorded meanwhile is not overwritten.
    const latest = (await this.deps.store.get<DcaPlan>(planKey(id))) ?? plan;
    const changed = base !== plan;
    const updated: DcaPlan = {
      ...latest,
      ...(changed ? { frequency: base.frequency, hourUtc: base.hourUtc, nextRunAt: base.nextRunAt } : {}),
      ...(changed ? (base.frequency === "monthly" ? { dayOfMonth: base.dayOfMonth! } : { weekday: base.weekday! }) : {}),
      ...(patch.label === undefined ? {} : { label: patch.label.trim().slice(0, 80) || plan.label }),
      ...(legs === undefined ? {} : { legs }),
      ...(patch.targetAmount === undefined ? {} : { legs: [], targetAmount: patch.targetAmount }),
      ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      ...(patch.autoExecute === undefined ? {} : { autoExecute: patch.autoExecute }),
    };
    if (changed) { if (updated.frequency === "monthly") delete updated.weekday; else delete updated.dayOfMonth; }
    if (legs !== undefined) delete updated.targetAmount;
    if (resumed) updated.nextRunAt = scheduleFrom(updated, now).toISOString();
    await this.deps.store.put(planKey(id), updated);
    return updated;
  }

  async deletePlan(id: string): Promise<void> {
    await this.getPlan(id);
    await this.deps.store.delete(planKey(id));
  }

  /**
   * Turn a plan into buy orders sized from the broker's last position price: Market orders, or Day
   * Limit orders capped at the last price plus an offset so a gap cannot fill them higher.
   * Trading 212 has no quote endpoint, so a leg you do not hold yet needs a manual first buy.
   */
  async buildBasket(plan: DcaPlan, now = new Date()): Promise<BasketRequest & { skipped: string[]; targetsSavedAt?: string }> {
    const dashboard = await this.deps.trading.getDashboard(plan.environment);
    const accountCurrency = (dashboard.account?.currency ?? "").toUpperCase();
    const converted = new Set<string>();
    const drafts: OrderDraft[] = [];
    const skipped: string[] = [];
    const instruments = await this.deps.trading.instruments(plan.environment);
    const find = (ticker: string) => {
      const position = dashboard.positions.find((item) => item.instrument.ticker.toUpperCase() === ticker.toUpperCase());
      return { position, instrument: position?.instrument ?? instruments.find((item) => item.ticker.toUpperCase() === ticker.toUpperCase()) };
    };
    // A plan by targets works out its buys from the account now: the largest gaps get the most.
    let legs = plan.legs;
    let targetsSavedAt: string | undefined;
    if (plan.targetAmount !== undefined) {
      const saved = await this.deps.targets?.(plan.environment);
      targetsSavedAt = saved?.updatedAt;
      if (!saved) skipped.push(`No target weights are saved for ${plan.environment.toUpperCase()}; save them with manage_target_allocation.`);
      const values = new Map(dashboard.positions.map((position) => [position.instrument.ticker, positionValue(position)]));
      const split = saved ? contributionSplit(saved.targets, values, plan.targetAmount) : [];
      for (const item of split.filter((leg) => leg.amount < MIN_TARGET_LEG)) skipped.push(`${item.ticker}: ${item.amount} ${accountCurrency} is too small to send; it stays in cash.`);
      legs = split.filter((leg) => leg.amount >= MIN_TARGET_LEG);
    }
    // Holdings imply most rates; a currency none of them is priced in takes the quote provider's.
    const { rates, quoted } = await this.deps.trading.ratesFor(dashboard.positions, accountCurrency, legs.flatMap((leg) => find(leg.ticker).instrument?.currencyCode ?? []));
    for (const leg of legs) {
      const { position, instrument } = find(leg.ticker);
      if (!instrument) { skipped.push(`${leg.ticker}: no longer listed by Trading 212.`); continue; }
      // Held legs use the broker's last price; others the external quote provider, when one can price them.
      const quote = position?.currentPrice ? undefined : await this.deps.trading.externalQuote(instrument);
      const price = position?.currentPrice || quote?.price;
      if (!price) { skipped.push(`${leg.ticker}: not held and no external quote is available; buy it once manually or configure QUOTE_PROVIDER / QUOTE_SYMBOLS.`); continue; }
      // Leg amounts are in the account currency; other quote currencies use the rate your holdings imply.
      const currency = instrument.currencyCode.toUpperCase();
      const fx = accountCurrency ? crossRate(rates, accountCurrency, currency) : undefined;
      if (!fx) { skipped.push(`${leg.ticker}: quoted in ${currency}; no holding in ${currency} gives an exchange rate from ${accountCurrency || "the account currency"} and the quote source has none.`); continue; }
      const external = quoted.get(currency);
      if (currency !== accountCurrency) converted.add(currency);
      const limitPrice = leg.orderType === "limit" ? planLimitPrice(price, leg.limitOffsetPercent ?? DEFAULT_LIMIT_OFFSET_PERCENT) : undefined;
      // A limit leg is sized at its limit, so it never spends more than the leg amount.
      const quantity = floorTo(leg.amount * fx / (limitPrice ?? price), 4);
      if (quantity <= 0) { skipped.push(`${leg.ticker}: ${leg.amount} ${accountCurrency} is less than the smallest tradable quantity.`); continue; }
      const base = {
        environment: plan.environment, ticker: instrument.ticker, side: "buy" as const, quantity, referencePrice: price, referencePriceAt: quote?.asOf ?? now.toISOString(),
        ...(external ? { fxRate: external.rate, fxRateAt: external.asOf } : {}),
      };
      drafts.push(limitPrice === undefined ? { ...base, type: "market" } : { ...base, type: "limit", limitPrice, timeValidity: "DAY" });
    }
    return {
      environment: plan.environment,
      purpose: "dca",
      title: plan.label,
      drafts,
      planId: plan.id,
      notes: [
        ...(plan.targetAmount === undefined ? [] : [`${plan.targetAmount} ${accountCurrency} split across the saved targets, most to the ones furthest below their weight; nothing is sold.`]),
        `Sized from each holding's last broker price, or an external quote for legs not held yet; ${legs.map((leg) => `${leg.amount} ${accountCurrency} ${leg.ticker}`).join(", ")}.`,
        ...(converted.size ? [`Amounts in ${[...converted].join(", ")} use ${quoted.size ? `the exchange rate your holdings imply or, where none does, ${[...quoted.values()][0]!.source}'s` : "the exchange rate the broker's valuation of your holdings implies"}; Trading 212 converts at its own rate and fee.`] : []),
        ...skipped,
      ],
      skipped,
      ...(targetsSavedAt ? { targetsSavedAt } : {}),
    };
  }

  async reviewPlan(id: string): Promise<Omit<BasketDraftPayload, "credentials" | "writeEnabled">> {
    const plan = await this.getPlan(id);
    const basket = await this.buildBasket(plan);
    return {
      kind: "basket_draft",
      environment: plan.environment,
      purpose: "dca",
      title: plan.label,
      legs: basket.drafts.map((draft) => ({ draft, reason: draft.type === "limit" ? `Plan "${plan.label}", limit ${draft.limitPrice}` : `Plan "${plan.label}"` })),
      notes: basket.notes ?? [],
      planId: plan.id,
    };
  }

  /** Called after a plan's basket was executed, whether by the user or by the scheduler. */
  async recordRun(planId: string, result: BasketExecutionResult, now = new Date()): Promise<void> {
    const plan = await this.deps.store.get<DcaPlan>(planKey(planId));
    if (!plan) return;
    // Any leg that reached the broker (submitted, rejected or unclear) uses up this due date, so a
    // scheduler tick never sends the plan again. Only a run stopped before sending stays due. A run
    // before the due date counts as that period's run, so the next one is the date after it.
    const attempted = result.legs.some((leg) => leg.result);
    const from = new Date(Math.max(now.getTime(), Date.parse(plan.nextRunAt) || 0));
    const { inFlightDueAt: _inFlight, ...rest } = plan;
    await this.deps.store.put(planKey(planId), {
      ...rest,
      lastRunAt: now.toISOString(),
      lastOutcome: result.message,
      ...(attempted ? { nextRunAt: nextRunAt(plan, from).toISOString() } : {}),
    });
  }

  /**
   * One scheduler tick. Due Live plans and Demo plans without autoExecute are announced once in
   * the activity log for the user to confirm. Due Demo autoExecute plans run when Demo automation
   * is enabled. A plan blocked before sending (policy, closed market) stays due and is tried again
   * when its run lock expires, about every 10 minutes.
   */
  async runDuePlans(now = new Date()): Promise<PlanRunReport[]> {
    const reports: PlanRunReport[] = [];
    for (const plan of await this.listPlans()) {
      if (plan.paused || Date.parse(plan.nextRunAt) > now.getTime()) continue;
      const unattended = plan.autoExecute && plan.environment === "demo" && this.deps.config.demoAutomationEnabled;
      if (!unattended) {
        const notice = await this.deps.store.increment(`plan-due:${plan.id}:${plan.nextRunAt}`, 40 * DAY_MS, now.getTime());
        if (notice.count === 1) await this.deps.trading.recordActivity("plan_due", plan.environment, { planId: plan.id });
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "awaiting_confirmation", message: `"${plan.label}" is due and waits for your confirmation.` });
        continue;
      }
      // A short lock stops overlapping ticks from sending the same plan twice.
      const lock = await this.deps.store.increment(`plan-lock:${plan.id}:${plan.nextRunAt}`, RUN_LOCK_MS, now.getTime());
      if (lock.count > 1) continue;
      // Re-read under the lock: a slower tick may have run it, or you may have paused or changed it.
      const latest = await this.deps.store.get<DcaPlan>(planKey(plan.id));
      if (!latest || latest.paused || latest.nextRunAt !== plan.nextRunAt) continue;
      if (latest.inFlightDueAt === latest.nextRunAt) {
        // An earlier tick began sending this due date and never recorded the result.
        const notice = await this.deps.store.increment(`plan-unclear:${plan.id}:${plan.nextRunAt}`, 40 * DAY_MS, now.getTime());
        const message = `"${plan.label}" may already have been sent for this due date, but the result was not recorded. Check Trading 212, then run or skip it yourself.`;
        if (notice.count === 1) await this.deps.trading.recordActivity("plan_due", plan.environment, { planId: plan.id, outcome: message.slice(0, 200) });
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "awaiting_confirmation", message });
        continue;
      }
      let marked = false;
      try {
        // Built from the plan as read under the lock, and sent only if it has not changed since.
        const basket = await this.buildBasket(latest, now);
        if (!basket.drafts.length) {
          await this.skip(plan, now, `Nothing to send: ${basket.skipped.join(" ")}`, true);
          reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "skipped", message: basket.skipped.join(" ") });
          continue;
        }
        const preview = await this.deps.trading.prepareBasket(basket, { quiet: true });
        // Unattended Market orders must not queue for a gap fill at the next open, whatever the policy
        // says; when the hours could not be read this tick, they wait for the next one too.
        const closed = preview.legs.filter((leg) => leg.notices.some((notice) =>
          notice.code === "MARKET_CLOSED_QUEUED" || (notice.code === "MARKET_HOURS_UNKNOWN" && notice.details?.reason === "unavailable")));
        if (closed.length) throw new Error(`Market closed or its hours unknown for ${closed.map((leg) => leg.draft.ticker).join(", ")}; the plan stays due until a tick inside the session.`);
        // Mark the due date before sending: if the result is never recorded, it is not sent again.
        // Read once more, so a change made while the basket was being priced is kept and respected.
        const current = await this.deps.store.get<DcaPlan>(planKey(plan.id));
        if (!current || current.paused || current.nextRunAt !== plan.nextRunAt) continue;
        // Legs edited while the basket was being priced: the next run lock window rebuilds it.
        if (JSON.stringify(current.legs) !== JSON.stringify(latest.legs) || current.targetAmount !== latest.targetAmount || !current.autoExecute) continue;
        // Targets changed or cleared while a plan by targets was being priced: the split is rebuilt next time.
        if (current.targetAmount !== undefined && (await this.deps.targets?.(plan.environment))?.updatedAt !== basket.targetsSavedAt) continue;
        await this.deps.store.put(planKey(plan.id), { ...current, inFlightDueAt: current.nextRunAt });
        marked = true;
        const result = await this.deps.trading.executeBasket(preview.token);
        await this.deps.trading.recordActivity("plan_auto_executed", plan.environment, { planId: plan.id, legs: result.legs.length, outcome: result.status });
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "auto", message: result.message, result });
      } catch (error) {
        const { code, message } = asStructuredError(error);
        // These are refused before anything is sent, so the mark can go; after any other error the
        // orders may have reached the broker and the plan waits for the user.
        if (marked && (code === "EXECUTION_BUSY" || code === "CONFIRMATION_EXPIRED")) {
          const current = await this.deps.store.get<DcaPlan>(planKey(plan.id));
          if (current?.inFlightDueAt) { const { inFlightDueAt: _f, ...rest } = current; await this.deps.store.put(planKey(plan.id), rest); }
        }
        await this.skip(plan, now, message, false);
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "skipped", message });
      }
    }
    return reports;
  }

  private async skip(plan: DcaPlan, now: Date, message: string, advance: boolean) {
    // Re-read: the user may have paused, changed or deleted the plan while this tick was working.
    const current = await this.deps.store.get<DcaPlan>(planKey(plan.id));
    if (!current) return;
    await this.deps.store.put(planKey(plan.id), {
      ...current,
      lastOutcome: message,
      ...(advance ? { lastRunAt: now.toISOString(), nextRunAt: nextRunAt(current, now).toISOString() } : {}),
    });
    // A blocked plan is retried every tick; log the reason once per due date, not every tick.
    const logged = await this.deps.store.increment(`plan-skip:${plan.id}:${plan.nextRunAt}`, 40 * DAY_MS, now.getTime());
    if (advance || logged.count === 1) await this.deps.trading.recordActivity("plan_skipped", plan.environment, { planId: plan.id, outcome: message.slice(0, 200) });
  }
}
