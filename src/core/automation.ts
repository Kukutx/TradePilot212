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
import { localDay, localHourStart, validTimeZone } from "../shared/time-zone.js";
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
  /** The hour in `timeZone`; 15:00 UTC when neither is given. */
  hour?: number;
  /** IANA zone; the server's TIMEZONE (else UTC) when an hour is given without one. */
  timeZone?: string;
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
  hour?: number;
  timeZone?: string;
}

export const MAX_PLANS = 50;
export const MAX_PLAN_LEGS = 10;
/** A new plan's hour when none is given: 15:00 UTC, inside the US and the main European sessions. */
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

type Schedule = Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hour" | "timeZone" | "anchorDay">;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** 1 (Monday) to 7 (Sunday). */
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Whether the plan runs on `day` (YYYY-MM-DD, in its zone). A biweekly plan with no anchor yet runs on its weekday. */
function runsOn(plan: Schedule, day: string): boolean {
  switch (plan.frequency) {
    case "daily": return weekdayOf(day) <= 5;
    case "weekly": return weekdayOf(day) === (plan.weekday ?? 1);
    case "biweekly": return weekdayOf(day) === (plan.weekday ?? 1) && (!plan.anchorDay || ((daysBetween(plan.anchorDay, day) % 14) + 14) % 14 === 0);
    case "monthly": {
      const [year, month] = day.split("-").map(Number) as [number, number];
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return Number(day.slice(8)) === Math.min(plan.dayOfMonth ?? 1, last);
    }
  }
}

/** The first due time strictly after `after`, in the plan's zone (summer time followed). */
export function nextRunAt(plan: Schedule, after: Date): Date {
  const zone = plan.timeZone || "UTC";
  let day = localDay(after.getTime(), zone);
  // A monthly plan runs within 31 days, a biweekly one within 14: 400 days bounds every schedule.
  for (let step = 0; step < 400; step++, day = shiftDay(day, 1)) {
    if (!runsOn(plan, day)) continue;
    const at = localHourStart(day, plan.hour, zone);
    if (at > after.getTime()) return new Date(at);
  }
  throw new Error("No run within 400 days");
}

/** The occurrence before `next` on the same schedule. */
function previousRunAt(plan: Schedule, next: Date): Date {
  const zone = plan.timeZone || "UTC";
  let day = shiftDay(localDay(next.getTime(), zone), -1);
  for (let step = 0; step < 400 && !runsOn(plan, day); step++) day = shiftDay(day, -1);
  return new Date(localHourStart(day, plan.hour, zone));
}

/** The next due date from `now`, skipping the coming one when this period already ran. */
export function scheduleFrom(plan: Schedule & Pick<DcaPlan, "lastRunAt">, now: Date): Date {
  const next = nextRunAt(plan, now);
  const lastRun = plan.lastRunAt ? Date.parse(plan.lastRunAt) : NaN;
  return Number.isFinite(lastRun) && lastRun > previousRunAt(plan, next).getTime() ? nextRunAt(plan, next) : next;
}

/** A biweekly plan's first run is its anchor: every other week from it. */
function anchored<T extends Schedule>(schedule: T, first: Date): T {
  const { anchorDay: _anchor, ...rest } = schedule;
  return (schedule.frequency === "biweekly" ? { ...rest, anchorDay: localDay(first.getTime(), schedule.timeZone || "UTC") } : rest) as T;
}

/** A plan as stored, in today's shape: one saved before 2.79 has a UTC hour (`hourUtc`). */
export function storedPlan(raw: DcaPlan & { hourUtc?: number }): DcaPlan {
  const { hourUtc, dayOfMonth, weekday, anchorDay, ...rest } = raw;
  // Only the fields its frequency uses: a weekday left on a monthly plan would read as a change on every save.
  const weekly = raw.frequency === "weekly" || raw.frequency === "biweekly";
  return {
    ...rest,
    ...(raw.frequency === "monthly" && dayOfMonth !== undefined ? { dayOfMonth } : {}),
    ...(weekly && weekday !== undefined ? { weekday } : {}),
    ...(raw.frequency === "biweekly" && anchorDay ? { anchorDay } : {}),
    hour: raw.hour ?? hourUtc ?? DEFAULT_HOUR_UTC,
    timeZone: raw.timeZone || "UTC",
  };
}

/** A plan without the mark of a run being sent. */
function settled(plan: DcaPlan): DcaPlan {
  const { inFlightDueAt: _due, inFlightSince: _since, ...rest } = plan;
  return rest;
}

function validateSchedule(input: Pick<PlanInput, "frequency" | "dayOfMonth" | "weekday" | "hour" | "timeZone">) {
  if (input.frequency === "monthly" && (input.dayOfMonth === undefined || !Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31))
    fail("INVALID_INPUT", "Monthly plans need dayOfMonth between 1 and 31 (a day past a month's end is its last day)", { field: "dayOfMonth" });
  if ((input.frequency === "weekly" || input.frequency === "biweekly") && (input.weekday === undefined || !Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7))
    fail("INVALID_INPUT", "Weekly and biweekly plans need weekday between 1 (Monday) and 7 (Sunday)", { field: "weekday" });
  if (input.hour !== undefined && (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23))
    fail("INVALID_INPUT", "hour must be an integer from 0 to 23", { field: "hour" });
  if (input.timeZone !== undefined && !validTimeZone(input.timeZone))
    fail("INVALID_INPUT", `Unknown time zone "${input.timeZone}"; use an IANA name such as Europe/London`, { field: "timeZone" });
}

/** The schedule fields a frequency keeps: a day of the month, a weekday, or neither (daily). */
function scheduleOf(input: Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hour" | "timeZone">): Schedule {
  return {
    frequency: input.frequency,
    ...(input.frequency === "monthly" ? { dayOfMonth: input.dayOfMonth! } : input.frequency === "daily" ? {} : { weekday: input.weekday! }),
    hour: input.hour,
    timeZone: input.timeZone,
  };
}

function assertAutoExecuteAllowed(environment: TradingEnvironment, autoExecute: boolean | undefined) {
  if (autoExecute && environment !== "demo") fail("INVALID_INPUT", "Unattended execution is only available for Demo plans. Live plans always wait for your confirmation.", { field: "autoExecute" });
}

export class AutomationService {
  constructor(private readonly deps: AutomationDeps) {}

  async listPlans(environment?: TradingEnvironment): Promise<DcaPlan[]> {
    const entries = await this.deps.store.list<DcaPlan>("plan:");
    return entries
      .map((entry) => storedPlan(entry.value))
      .filter((plan) => !environment || plan.environment === environment)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async getPlan(id: string): Promise<DcaPlan> {
    const plan = await this.read(id);
    if (!plan) fail("PLAN_NOT_FOUND", "Plan not found", { planId: id });
    return plan;
  }

  /** A stored plan in today's shape, or nothing. */
  private async read(id: string): Promise<DcaPlan | undefined> {
    const plan = await this.deps.store.get<DcaPlan>(planKey(id));
    return plan ? storedPlan(plan) : undefined;
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
    // An hour without a zone is the server's local hour; neither is 15:00 UTC, as before.
    const timeZone = input.timeZone ?? (input.hour === undefined ? "UTC" : this.deps.config.timeZone ?? "UTC");
    const plain = scheduleOf({ frequency: input.frequency, dayOfMonth: input.dayOfMonth, weekday: input.weekday, hour: input.hour ?? DEFAULT_HOUR_UTC, timeZone } as DcaPlan);
    const first = nextRunAt(plain, now);
    const schedule = anchored(plain, first);
    const plan: DcaPlan = {
      id: `dca_${randomToken(12)}`,
      environment: input.environment,
      label: input.label.trim().slice(0, 80) || "DCA plan",
      legs: byTargets ? [] : await this.resolveLegs(input.environment, input.legs),
      ...(byTargets ? { targetAmount: input.targetAmount! } : {}),
      ...schedule,
      autoExecute: !!input.autoExecute,
      paused: false,
      nextRunAt: first.toISOString(),
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(planKey(plan.id), plan);
    return plan;
  }

  async updatePlan(id: string, patch: PlanPatch, now = new Date()): Promise<DcaPlan> {
    const plan = await this.getPlan(id);
    assertAutoExecuteAllowed(plan.environment, patch.autoExecute);
    let base: DcaPlan = plan;
    if ([patch.frequency, patch.dayOfMonth, patch.weekday, patch.hour, patch.timeZone].some((value) => value !== undefined)) {
      const frequency = patch.frequency ?? plan.frequency;
      const wanted = {
        frequency,
        dayOfMonth: patch.dayOfMonth ?? plan.dayOfMonth,
        weekday: patch.weekday ?? plan.weekday,
        hour: patch.hour ?? plan.hour,
        timeZone: patch.timeZone ?? plan.timeZone,
      };
      validateSchedule(wanted);
      // A new schedule starts from now; the old due date no longer applies. A period that already
      // ran is not run again just because its hour or day moved. A biweekly plan counts its
      // fortnights from its new first run.
      const plain = scheduleOf(wanted as DcaPlan);
      const lastRun = plan.lastRunAt ? { lastRunAt: plan.lastRunAt } : {};
      const { dayOfMonth: _day, weekday: _weekday, anchorDay: _anchor, ...rest } = plan;
      const sameDays = JSON.stringify({ ...plain, hour: 0 }) === JSON.stringify({ ...scheduleOf(plan), hour: 0 });
      if (sameDays) {
        // Only the hour moved: the run stays on the day it was due (a skipped run stays skipped), and a biweekly plan on
        // its weeks; where that hour has passed today, on the next day the schedule runs.
        const kept: Schedule = plan.anchorDay ? { ...plain, anchorDay: plan.anchorDay } : plain;
        const zone = plain.timeZone || "UTC";
        const sameDay = localHourStart(localDay(Date.parse(plan.nextRunAt), zone), plain.hour, zone);
        const next = sameDay > now.getTime() ? new Date(sameDay) : scheduleFrom({ ...kept, ...lastRun }, now);
        base = { ...rest, ...(kept.anchorDay ? kept : anchored(plain, next)), nextRunAt: next.toISOString() };
      } else {
        const next = scheduleFrom({ ...plain, ...lastRun }, now);
        base = { ...rest, ...anchored(plain, next), nextRunAt: next.toISOString() };
      }
    }
    if (patch.legs !== undefined && patch.targetAmount !== undefined) fail("INVALID_INPUT", "Give either legs or targetAmount, not both", { field: "targetAmount" });
    if (patch.targetAmount !== undefined) validateTargetAmount(patch.targetAmount);
    const legs = patch.legs === undefined ? undefined : await this.resolveLegs(plan.environment, patch.legs);
    // Unpausing schedules from now instead of firing a due date that passed while paused.
    const resumed = patch.paused === false && plan.paused && Date.parse(base.nextRunAt) <= now.getTime();
    // Re-read after the awaits above, so a run recorded meanwhile is not overwritten.
    const latest = (await this.read(id)) ?? plan;
    const changed = base !== plan;
    if (changed) { delete latest.dayOfMonth; delete latest.weekday; delete latest.anchorDay; }
    const updated: DcaPlan = {
      ...latest,
      ...(changed ? { frequency: base.frequency, hour: base.hour, timeZone: base.timeZone, nextRunAt: base.nextRunAt } : {}),
      ...(changed && base.dayOfMonth !== undefined ? { dayOfMonth: base.dayOfMonth } : {}),
      ...(changed && base.weekday !== undefined ? { weekday: base.weekday } : {}),
      ...(changed && base.anchorDay !== undefined ? { anchorDay: base.anchorDay } : {}),
      ...(patch.label === undefined ? {} : { label: patch.label.trim().slice(0, 80) || plan.label }),
      ...(legs === undefined ? {} : { legs }),
      ...(patch.targetAmount === undefined ? {} : { legs: [], targetAmount: patch.targetAmount }),
      ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      ...(patch.autoExecute === undefined ? {} : { autoExecute: patch.autoExecute }),
    };
    if (legs !== undefined) delete updated.targetAmount;
    if (resumed) updated.nextRunAt = scheduleFrom(updated, now).toISOString();
    await this.deps.store.put(planKey(id), updated);
    return updated;
  }

  /**
   * Leave out the plan's next run: it becomes due on the run after. A plan that is due now (its run waiting for you)
   * moves on from now, so the run waiting is the one left out.
   */
  async skipNextRun(id: string, now = new Date()): Promise<DcaPlan> {
    const plan = await this.getPlan(id);
    // An unattended run of this due date begun moments ago may be sending its orders: skipping now would also skip the
    // run after it. One begun longer ago never recorded its result, and skipping it is how you settle it.
    const since = plan.inFlightSince ? Date.parse(plan.inFlightSince) : NaN;
    if (plan.inFlightDueAt === plan.nextRunAt && Number.isFinite(since) && now.getTime() - since < RUN_LOCK_MS)
      fail("EXECUTION_BUSY", "This plan's run is being sent right now. Try again in a few minutes, once its result is in.");
    const from = new Date(Math.max(now.getTime(), Date.parse(plan.nextRunAt) || 0));
    const updated: DcaPlan = { ...settled(plan), nextRunAt: nextRunAt(plan, from).toISOString(), lastOutcome: `Skipped the run due ${plan.nextRunAt}.` };
    await this.deps.store.put(planKey(id), updated);
    await this.deps.trading.recordActivity("plan_skipped", plan.environment, { planId: id, outcome: `skipped the run due ${plan.nextRunAt}` });
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
    const plan = await this.read(planId);
    if (!plan) return;
    // Any leg that reached the broker (submitted, rejected or unclear) uses up this due date, so a
    // scheduler tick never sends the plan again. Only a run stopped before sending stays due. A run
    // before the due date counts as that period's run, so the next one is the date after it.
    const attempted = result.legs.some((leg) => leg.result);
    const from = new Date(Math.max(now.getTime(), Date.parse(plan.nextRunAt) || 0));
    await this.deps.store.put(planKey(planId), {
      ...settled(plan),
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
      const latest = await this.read(plan.id);
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
        const current = await this.read(plan.id);
        if (!current || current.paused || current.nextRunAt !== plan.nextRunAt) continue;
        // Legs edited while the basket was being priced: the next run lock window rebuilds it.
        if (JSON.stringify(current.legs) !== JSON.stringify(latest.legs) || current.targetAmount !== latest.targetAmount || !current.autoExecute) continue;
        // Targets changed or cleared while a plan by targets was being priced: the split is rebuilt next time.
        if (current.targetAmount !== undefined && (await this.deps.targets?.(plan.environment))?.updatedAt !== basket.targetsSavedAt) continue;
        await this.deps.store.put(planKey(plan.id), { ...current, inFlightDueAt: current.nextRunAt, inFlightSince: now.toISOString() });
        marked = true;
        const result = await this.deps.trading.executeBasket(preview.token);
        await this.deps.trading.recordActivity("plan_auto_executed", plan.environment, { planId: plan.id, legs: result.legs.length, outcome: result.status });
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "auto", message: result.message, result });
      } catch (error) {
        const { code, message } = asStructuredError(error);
        // These are refused before anything is sent, so the mark can go; after any other error the
        // orders may have reached the broker and the plan waits for the user.
        if (marked && (code === "EXECUTION_BUSY" || code === "CONFIRMATION_EXPIRED")) {
          const current = await this.read(plan.id);
          if (current?.inFlightDueAt) await this.deps.store.put(planKey(plan.id), settled(current));
        }
        await this.skip(plan, now, message, false);
        reports.push({ planId: plan.id, environment: plan.environment, dueAt: plan.nextRunAt, mode: "skipped", message });
      }
    }
    return reports;
  }

  private async skip(plan: DcaPlan, now: Date, message: string, advance: boolean) {
    // Re-read: the user may have paused, changed or deleted the plan while this tick was working.
    const current = await this.read(plan.id);
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
