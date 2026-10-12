// Alerts on the account as a whole: its total value or free cash crossing an amount, and its day's move. Each
// scheduler tick reads the account summary once per environment (or takes one read seconds before); the day's-move
// alerts of an environment read the day's move together, from get_portfolio_today's holdings (their closes and the
// day's fills), at most every ten minutes. A triggered
// alert writes an account_alert_triggered activity event (and webhook, when configured) once, then stays triggered
// until it is re-armed; a day's-move alert arms itself again on the next trading day. Alerts never place or cancel
// orders.

import type { AccountSummary, TradingEnvironment } from "../shared/contracts.js";
import type { AccountAlert, AccountAlertCondition, AccountAlertReport } from "../shared/automation.js";
import type { PortfolioToday } from "../shared/today.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";
import { randomToken } from "./web-utils.js";

export const MAX_ACCOUNT_ALERTS = 20;
/** How often the day's-move alerts read the day's move: it reads every holding's closes and the day's fills. */
export const DAY_MOVE_EVERY_MS = 10 * 60_000;
/** An account summary read this recent (alone, or with the day's move just before) is used as it is. */
export const SUMMARY_REUSE_MS = 30_000;
/** How often a waiting alert writes its last value, to keep ticks cheap; one that fires writes at once. */
const WRITE_EVERY_MS = 10 * 60_000;
const alertKey = (id: string) => `account-alert:${id}`;

export interface AccountAlertInput {
  environment: TradingEnvironment;
  condition: AccountAlertCondition;
  amount?: number;
  percent?: number;
  note?: string;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const money = (value: number, currency: string | undefined) => `${round(value).toFixed(2)}${currency ? ` ${currency}` : ""}`;

/** Whether a value or cash alert fires on `account`, and what it read. */
export function evaluateAccountAlert(alert: AccountAlert, account: AccountSummary): { fired: boolean; value?: number; message: string } {
  const currency = account.currency ?? alert.currency;
  const cash = alert.condition === "cash_above" || alert.condition === "cash_below";
  const value = cash ? account.cash?.availableToTrade : account.totalValue;
  const what = cash ? "Free cash" : "The account value";
  if (value === undefined || !Number.isFinite(value)) return { fired: false, message: `Trading 212 did not report ${cash ? "the free cash" : "the account value"}.` };
  const above = alert.condition === "value_above" || alert.condition === "cash_above";
  return {
    fired: above ? value >= alert.amount! : value <= alert.amount!,
    value,
    message: `${what} is ${money(value, currency)}, at or ${above ? "above" : "below"} ${money(alert.amount!, currency)}.`,
  };
}

export interface AccountDayMove {
  /** The latest trading day of the holdings with a move. */
  day: string;
  /** The moves on that day, added up, against the holdings' value before them. */
  change: number;
  profitLoss: number;
  /** Holdings with a move on that day, of all of them. */
  counted: number;
  of: number;
  /** When that day's sessions all closed (ms), when the schedules say. */
  closed?: number;
}

/**
 * The account's move on its latest trading day, from get_portfolio_today: only the holdings whose move is from that
 * day count, so a holding still on the session before (another exchange, before its open) is not counted twice.
 * With every holding counted on that day, the change is against their base, as get_portfolio_today's total; otherwise
 * against Trading 212's value of the holdings now less that day's moves, the others taken as flat.
 */
export function accountDayMove(today: PortfolioToday): AccountDayMove | { problem: string } {
  const moved = today.moves.filter((move) => move.profitLoss !== undefined && Number.isFinite(move.profitLoss));
  const day = moved.map((move) => move.day).sort().at(-1);
  if (!day) return { problem: "No holding has a move for the day yet." };
  const onDay = moved.filter((move) => move.day === day);
  const profitLoss = onDay.reduce((sum, move) => sum + move.profitLoss!, 0);
  const whole = onDay.length === today.moves.length;
  if (!whole && today.invested === undefined) {
    return { problem: `Trading 212 did not report the holdings' value, so the day's move of ${onDay.length} of ${today.moves.length} holdings cannot be put against the account.` };
  }
  const base = whole ? onDay.reduce((sum, move) => sum + (move.base ?? 0), 0) : today.invested! - profitLoss;
  if (!(base > 0)) return { problem: "The holdings have no value to measure the day's move against." };
  const closed = today.ended?.[day];
  return { day, change: profitLoss / base, profitLoss: round(profitLoss), counted: onDay.length, of: today.moves.length, ...(closed !== undefined ? { closed } : {}) };
}

/** An alert without its trigger: armed again. A day's move keeps the day it last fired for, so it counts from the next. */
function untriggered(alert: AccountAlert): AccountAlert {
  const { triggeredAt: _t, triggeredValue: _v, ...rest } = alert;
  return rest;
}

export class AccountAlerts {
  constructor(private readonly deps: {
    config: RuntimeConfig;
    store: StateStore;
    trading: Pick<TradingService, "accountSummary" | "accountCurrency" | "recordActivity">;
    /** The day's move of each holding and the account (get_portfolio_today); without it day's-move alerts wait. */
    today?: (environment: TradingEnvironment, now: Date) => Promise<PortfolioToday>;
  }) {}

  async list(environment?: TradingEnvironment): Promise<AccountAlert[]> {
    return (await this.deps.store.list<AccountAlert>("account-alert:"))
      .map((entry) => entry.value)
      .filter((alert) => !environment || alert.environment === environment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(input: AccountAlertInput, now = new Date()): Promise<AccountAlert> {
    requireCredentials(this.deps.config, input.environment);
    if ((await this.list()).length >= MAX_ACCOUNT_ALERTS) fail("INVALID_INPUT", `At most ${MAX_ACCOUNT_ALERTS} account alerts can be stored`);
    const byPercent = input.condition === "day_move";
    if (byPercent && !(input.percent! > 0 && input.percent! < 100)) fail("INVALID_INPUT", "A day_move alert needs a percent above 0 and below 100", { field: "percent" });
    if (!byPercent && !(input.amount! > 0)) fail("INVALID_INPUT", `A ${input.condition} alert needs a positive amount in the account currency`, { field: "amount" });
    const currency = await this.deps.trading.accountCurrency(input.environment).catch(() => undefined);
    const alert: AccountAlert = {
      id: `aal_${randomToken(12)}`,
      environment: input.environment,
      condition: input.condition,
      ...(byPercent ? { percent: input.percent! } : { amount: input.amount! }),
      ...(currency ? { currency } : {}),
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(alertKey(alert.id), alert);
    return alert;
  }

  private async get(id: string): Promise<AccountAlert> {
    const alert = await this.deps.store.get<AccountAlert>(alertKey(id));
    if (!alert) fail("ALERT_NOT_FOUND", "Account alert not found", { alertId: id });
    return alert;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.deps.store.delete(alertKey(id));
  }

  /** Arm a triggered alert again; a day's move counts from the next trading day. */
  async rearm(id: string): Promise<AccountAlert> {
    const alert = untriggered(await this.get(id));
    await this.deps.store.put(alertKey(id), alert);
    return alert;
  }

  /** Notes that a day's-move alert was read, when nothing else changed it meanwhile. */
  private async touch(alert: AccountAlert, now: Date): Promise<void> {
    const current = await this.deps.store.get<AccountAlert>(alertKey(alert.id));
    if (current && current.createdAt === alert.createdAt && current.triggeredAt === alert.triggeredAt) await this.deps.store.put(alertKey(alert.id), { ...current, lastCheckedAt: now.toISOString() });
  }

  /**
   * One scheduler tick. The day's-move alerts of an environment read the day's move together, when one of them has
   * not for ten minutes, and go first: the value and cash alerts then take the account summary that read came with,
   * else read it once per environment.
   */
  async check(now = new Date()): Promise<AccountAlertReport[]> {
    const listed = (await this.list()).filter((alert) => !alert.triggeredAt || alert.condition === "day_move");
    if (!listed.length) return [];
    const due = [...listed.filter((alert) => alert.condition === "day_move"), ...listed.filter((alert) => alert.condition !== "day_move")];
    const read = (alert: AccountAlert) => alert.lastCheckedAt !== undefined && now.getTime() - Date.parse(alert.lastCheckedAt) < DAY_MOVE_EVERY_MS;
    // An environment's day's-move alerts are read and stamped together, so more of them do not mean more reads.
    const moveDue = new Set(listed.filter((alert) => alert.condition === "day_move" && !read(alert)).map((alert) => alert.environment));
    const credentials = credentialStatus(this.deps.config);
    const reports: AccountAlertReport[] = [];
    const accounts = new Map<TradingEnvironment, Promise<AccountSummary | Error>>();
    const days = new Map<TradingEnvironment, Promise<PortfolioToday | Error>>();
    const caught = (error: unknown) => new Error(asStructuredError(error).message);
    const waiting = (alert: AccountAlert, message: string) => reports.push({ alertId: alert.id, environment: alert.environment, action: "waiting", message });
    for (const alert of due) {
      if (!credentials[alert.environment]) continue;
      let outcome: { fired: boolean; value?: number; day?: string; message: string; currency?: string };
      // A day's move that fired on an earlier trading day is armed again.
      let fresh = false;
      if (alert.condition === "day_move") {
        // Read at most every ten minutes, whether it fired today or not.
        if (!moveDue.has(alert.environment)) continue;
        if (!this.deps.today) { waiting(alert, "The day's move cannot be read here."); continue; }
        if (!days.has(alert.environment)) days.set(alert.environment, this.deps.today(alert.environment, now).catch(caught));
        const today = await days.get(alert.environment)!;
        const move = today instanceof Error ? { problem: today.message } : accountDayMove(today);
        if ("problem" in move) {
          // Tried: the next try is ten minutes on, as after a read.
          await this.touch(alert, now);
          waiting(alert, move.problem);
          continue;
        }
        const currency = (today instanceof Error ? undefined : today.accountCurrency) ?? alert.currency;
        const said = `The account is ${move.change >= 0 ? "+" : ""}${(move.change * 100).toFixed(2)}% on ${move.day} (${move.profitLoss >= 0 ? "+" : ""}${money(move.profitLoss, currency)} across ${move.counted} of ${move.of} holdings; alert at ${alert.percent}% either way).`;
        const done = alert.triggeredDay !== undefined && move.day <= alert.triggeredDay;
        fresh = alert.triggeredAt !== undefined && !done;
        // A session that closed before the alert was set is not its to report; without the schedules, one on an
        // earlier day (UTC) than it.
        const before = move.closed !== undefined ? Date.parse(alert.createdAt) >= move.closed : alert.createdAt.slice(0, 10) > move.day;
        const reading = { value: move.change, day: move.day, ...(currency ? { currency } : {}) };
        outcome = done
          ? { ...reading, fired: false, message: `${said} It fired for ${alert.triggeredDay} already; it counts from the next trading day.` }
          : before
            ? { ...reading, fired: false, message: `${said} That session was over before the alert was set; it counts from the next.` }
            : { ...reading, fired: Math.abs(move.change) * 100 >= alert.percent! - 1e-9, message: said };
      } else {
        if (!accounts.has(alert.environment)) accounts.set(alert.environment, this.deps.trading.accountSummary(alert.environment, SUMMARY_REUSE_MS).catch(caught));
        const account = await accounts.get(alert.environment)!;
        if (account instanceof Error) { waiting(alert, account.message); continue; }
        const currency = account.currency ?? alert.currency;
        outcome = { ...evaluateAccountAlert(alert, account), ...(currency ? { currency } : {}) };
      }
      const kept = (value: number) => (alert.condition === "day_move" ? round(value, 6) : round(value));
      const tick: Partial<AccountAlert> = {
        ...(outcome.value !== undefined ? { lastValue: kept(outcome.value) } : {}),
        ...(outcome.day ? { lastDay: outcome.day } : {}),
        lastCheckedAt: now.toISOString(),
        ...(outcome.fired ? { triggeredAt: now.toISOString(), ...(outcome.value !== undefined ? { triggeredValue: kept(outcome.value) } : {}), ...(outcome.day ? { triggeredDay: outcome.day } : {}) } : {}),
      };
      const stale = !alert.lastCheckedAt || now.getTime() - Date.parse(alert.lastCheckedAt) >= WRITE_EVERY_MS;
      if (fresh || outcome.fired || stale || alert.condition === "day_move") {
        // Re-read: the alert may have been deleted, re-armed or fired elsewhere while this tick read the account.
        const current = await this.deps.store.get<AccountAlert>(alertKey(alert.id));
        if (!current || current.createdAt !== alert.createdAt || current.triggeredAt !== alert.triggeredAt) continue;
        await this.deps.store.put(alertKey(alert.id), { ...(fresh ? untriggered(current) : current), ...tick });
      }
      if (outcome.fired) {
        await this.deps.trading.recordActivity("account_alert_triggered", alert.environment, {
          alertId: alert.id,
          ...(alert.condition !== "day_move" && outcome.value !== undefined ? { value: round(outcome.value), ...(outcome.currency ? { valueCurrency: outcome.currency } : {}) } : {}),
          outcome: `${outcome.message}${alert.note ? ` ${alert.note}` : ""}`.slice(0, 200),
        });
        reports.push({ alertId: alert.id, environment: alert.environment, action: "triggered", message: outcome.message });
      } else {
        waiting(alert, outcome.message);
      }
    }
    return reports;
  }
}
