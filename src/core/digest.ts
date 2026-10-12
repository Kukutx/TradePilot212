// A once-a-day account digest sent to the notification webhook at DIGEST_HOUR_UTC, so you can
// follow the account without opening a chat. It only reads; it never trades. It is sent whatever
// NOTIFY_EVENTS lists, and a day counts as done only once the webhook accepted it.

import type { Position, TradingEnvironment } from "../shared/contracts.js";
import type { HistoryDividendItem } from "../shared/history.js";
import { stopProtection } from "../shared/protection.js";
import type { DcaPlan, PriceAlert, TargetAllocation } from "../shared/automation.js";
import type { PortfolioToday } from "../shared/today.js";
import { analyzeAllocation, forwardDividends, positionValue } from "./analytics.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { Notifier } from "./notify.js";
import { scheduleStart } from "./dividends.js";
import { recentFillCount } from "./order-watch.js";
import type { StateStore } from "./state-store.js";
import { allocationDrift } from "./targets.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
const round = (value: number) => Math.round(value * 100) / 100;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${round(value)}`;
const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${round(value * 100)}%`;
/** Holdings named as the day's biggest movers. */
const MOVERS = 3;
/** Expected dividends named: the soonest in the coming week. */
const EXPECTED_DIVIDENDS = 3;
/** Instruments named among the dividends received; the rest are counted. */
const RECEIVED_DIVIDENDS = 5;
const WEEK_MS = 7 * DAY_MS;
/** A dividend can reach the history a few days after the time it is dated; the digest looks back this far for one it has not named. */
const LATE_DIVIDEND_MS = 3 * DAY_MS;
/** Dividends received are named from at most this long ago, however long since the last digest that read them. */
const MAX_DIVIDEND_LOOKBACK_MS = 31 * DAY_MS;

export interface DigestInput {
  environment: TradingEnvironment;
  currency: string;
  totalValue: number;
  previousTotalValue?: number;
  cash: number;
  unrealized?: number;
  positions: Array<{ ticker: string; value: number; profitLoss?: number }>;
  pendingOrders: number;
  duePlans: string[];
  triggeredAlerts: number;
  /** Orders the order watch saw fill, fully or partly, in the last day. */
  filledOrders?: number;
  /** Largest drift from the saved targets, in weight points, when targets are saved. */
  maxDrift?: number;
  /**
   * Holdings that no sell stop fully covers, given only when some holding has a stop: someone who uses
   * stops wants to see the gaps, someone who never does would read the same list every day.
   */
  uncovered?: string[];
  /** The holdings' move on their last session (the dashboard's day), and the biggest movers by amount. */
  day?: { days: string[]; profitLoss: number; change?: number; counted: number; of: number; movers: Array<{ name: string; change?: number; profitLoss: number }> };
  /** Dividends paid since the last digest, and those expected in the coming week (or due and not paid yet). */
  dividends?: DigestDividends;
}

export interface DigestDividends {
  received: Array<{ name: string; amount: number }>;
  expected: Array<{ name: string; on: string; amount: number; due: boolean }>;
}

/** What the last digest with dividends read: when, and the payments dated in the few days before that it had seen. */
export interface DividendMark { at: string; seen: string[] }

/** A payment's identity in the history: Trading 212's reference, or what it paid and when. */
const dividendKey = (item: HistoryDividendItem) => item.reference ?? `${item.ticker ?? item.instrument?.ticker}|${item.paidOn}|${item.amount}`;

/** Where the digest names dividends received from: a little before the last digest that read them, or the last day for the first. */
export function dividendsSince(mark: DividendMark | undefined, now: Date): number {
  const at = typeof mark?.at === "string" ? Date.parse(mark.at) : Number.NaN;
  if (!(at <= now.getTime())) return now.getTime() - DAY_MS;
  return Math.max(at - LATE_DIVIDEND_MS, now.getTime() - MAX_DIVIDEND_LOOKBACK_MS);
}

/** The mark to keep after a digest named the dividends of `dividends`: every payment dated in the few days before `now` was seen. */
export function dividendMark(dividends: HistoryDividendItem[], now: Date): DividendMark {
  const from = now.getTime() - LATE_DIVIDEND_MS;
  const seen = dividends.filter((item) => {
    const at = Date.parse(item.paidOn ?? "");
    return at > from && at <= now.getTime();
  });
  return { at: now.toISOString(), seen: [...new Set(seen.map(dividendKey))] };
}

/**
 * The digest's dividends from the dividend history (read from the first day of this month a year ago, as the income
 * summary's expected dividends are). Received: each instrument's payments dated after `since` that the last digest had
 * not seen, largest first; a payment that reached the history late is named the day it appears. Expected: the payments
 * the holdings are expected to make in the coming seven days, soonest first, then any due in the last seven days and
 * not paid yet; none when the history read stopped short of the year the expected payments are read from.
 */
export function digestDividends(dividends: HistoryDividendItem[], positions: Position[], window: { since: number; seen?: string[]; truncated?: boolean }, now: Date): DigestDividends {
  const names = new Map(positions.map((position) => [position.instrument.ticker, position.instrument.shortName || position.instrument.ticker]));
  const seen = new Set(window.seen ?? []);
  const received = new Map<string, number>();
  for (const item of dividends) {
    const at = Date.parse(item.paidOn ?? "");
    const ticker = item.ticker ?? item.instrument?.ticker;
    if (!ticker || !item.amount || !(at > window.since && at <= now.getTime()) || seen.has(dividendKey(item))) continue;
    received.set(ticker, (received.get(ticker) ?? 0) + item.amount);
  }
  const day = (offset: number) => new Date(now.getTime() + offset).toISOString().slice(0, 10);
  const today = day(0);
  const weekOn = day(WEEK_MS);
  const weekAgo = day(-WEEK_MS);
  const upcoming = window.truncated ? [] : forwardDividends(dividends, positions, now, now).upcoming ?? [];
  const expected = upcoming.filter((payment) => payment.on >= weekAgo && payment.on < weekOn)
    .map((payment) => ({ name: names.get(payment.ticker) ?? payment.ticker, on: payment.on, amount: payment.amount, due: payment.on < today }));
  return {
    received: [...received].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]).map(([ticker, amount]) => ({ name: names.get(ticker) ?? ticker, amount: round(amount) })),
    // Coming first: one due and not paid may never come, and should not crowd out the week's.
    expected: [...expected.filter((payment) => !payment.due), ...expected.filter((payment) => payment.due)],
  };
}

/** The digest's day from the dashboard's: the total and the holdings that moved most in the account currency. */
export function digestDay(today: PortfolioToday | undefined): DigestInput["day"] {
  const total = today?.total;
  if (!today || !total) return undefined;
  const counted = today.moves.filter((move) => move.profitLoss !== undefined);
  return {
    days: [...new Set(counted.map((move) => move.day))].sort(),
    profitLoss: total.profitLoss,
    ...(total.change === undefined ? {} : { change: total.change }),
    counted: total.counted,
    of: total.of,
    // The moves come biggest first.
    movers: counted.slice(0, MOVERS).map((move) => ({ name: move.shortName ?? move.ticker, ...(move.change === undefined ? {} : { change: move.change }), profitLoss: move.profitLoss! })),
  };
}

/** Plain-text digest; kept short so it reads well in a chat notification. */
export function digestText(input: DigestInput): string {
  const change = input.previousTotalValue === undefined ? "" : ` (${signed(input.totalValue - input.previousTotalValue)} since the last digest)`;
  const top = [...input.positions].sort((a, b) => b.value - a.value).slice(0, 3)
    .map((item) => `${item.ticker} ${round(item.value)}${item.profitLoss === undefined ? "" : ` (${signed(item.profitLoss)})`}`);
  const day = input.day;
  return [
    `Total ${round(input.totalValue)} ${input.currency}${change}`,
    day ? `day ${signed(day.profitLoss)}${day.change === undefined ? "" : ` (${signedPct(day.change)})`} on ${day.days.join(", ")}${day.counted < day.of ? ` for ${day.counted} of ${day.of} instruments` : ""}` : undefined,
    // One sold out on the day has no price to compare: its sells' amount instead.
    day?.movers.length ? `movers: ${day.movers.map((mover) => `${mover.name} ${mover.change === undefined ? `${signed(mover.profitLoss)} ${input.currency}`.trim() : signedPct(mover.change)}`).join(", ")}` : undefined,
    `cash ${round(input.cash)}`,
    input.unrealized === undefined ? undefined : `unrealized ${signed(input.unrealized)}`,
    top.length ? `top: ${top.join(", ")}` : undefined,
    input.pendingOrders ? `${input.pendingOrders} pending order(s)` : undefined,
    input.duePlans.length ? `due plans: ${input.duePlans.join(", ")}` : undefined,
    input.triggeredAlerts ? `${input.triggeredAlerts} alert(s) triggered in the last day` : undefined,
    input.filledOrders ? `${input.filledOrders} order(s) filled in the last day` : undefined,
    input.dividends?.received.length
      ? `dividends ${round(input.dividends.received.reduce((sum, item) => sum + item.amount, 0))} in: ${input.dividends.received.slice(0, RECEIVED_DIVIDENDS).map((item) => `${item.name} ${round(item.amount)}`).join(", ")}${input.dividends.received.length > RECEIVED_DIVIDENDS ? ` +${input.dividends.received.length - RECEIVED_DIVIDENDS}` : ""}`
      : undefined,
    input.dividends?.expected.length
      ? `dividends expected this week: ${input.dividends.expected.slice(0, EXPECTED_DIVIDENDS).map((item) => `${item.name} ~${round(item.amount)} ${item.due ? `due ${item.on.slice(5)}` : item.on.slice(5)}`).join(", ")}${input.dividends.expected.length > EXPECTED_DIVIDENDS ? ` +${input.dividends.expected.length - EXPECTED_DIVIDENDS}` : ""}`
      : undefined,
    input.maxDrift === undefined ? undefined : `largest drift from targets ${(input.maxDrift * 100).toFixed(1)} points`,
    input.uncovered?.length ? `no full stop-loss: ${input.uncovered.slice(0, 5).join(", ")}${input.uncovered.length > 5 ? ` +${input.uncovered.length - 5}` : ""}` : undefined,
  ].filter(Boolean).join(" · ");
}

const RETRY_MS = 15 * 60_000;

export class DailyDigest {
  constructor(private readonly deps: {
    config: RuntimeConfig; store: StateStore; trading: TradingService; notify?: Notifier;
    targets?: (environment: TradingEnvironment) => Promise<TargetAllocation | undefined>;
    /** The holdings' day; a read that fails leaves it out of the digest. */
    today?: (environment: TradingEnvironment, now: Date) => Promise<PortfolioToday>;
    /**
     * The dividend history from `from`, newest first, and whether it stopped at the page limit; a read that fails leaves
     * dividends out of the digest, and the next digest names what it missed.
     */
    dividends?: (environment: TradingEnvironment, from: Date, now: Date) => Promise<{ items: HistoryDividendItem[]; truncated: boolean }>;
  }) {}

  /** Send at most one digest per environment per UTC day, at or after DIGEST_HOUR_UTC. */
  async run(now = new Date()): Promise<string[]> {
    const hour = this.deps.config.digestHourUtc;
    if (hour === undefined || !this.deps.notify || now.getUTCHours() < hour) return [];
    const day = now.toISOString().slice(0, 10);
    const sent: string[] = [];
    const credentials = credentialStatus(this.deps.config);
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      // A failed attempt (rate limit, outage) is retried every 15 minutes for the rest of the day.
      const attempt = await this.deps.store.increment(`digest-try:${environment}:${day}`, RETRY_MS, now.getTime());
      if (attempt.count > 1) continue;
      const claimKey = `digest:${environment}:${day}`;
      const claim = await this.deps.store.increment(claimKey, 2 * DAY_MS, now.getTime());
      if (claim.count > 1) continue;
      try {
        const dashboard = await this.deps.trading.getDashboard(environment);
        const account = dashboard.account;
        if (!account) {
          await this.deps.store.delete(claimKey);
          continue;
        }
        const previous = await this.deps.store.get<number>(`digest-value:${environment}`);
        const plans = (await this.deps.store.list<DcaPlan>("plan:")).map((entry) => entry.value)
          .filter((plan) => plan.environment === environment && !plan.paused && Date.parse(plan.nextRunAt) <= now.getTime());
        const alerts = (await this.deps.store.list<PriceAlert>("alert:")).map((entry) => entry.value)
          .filter((alert) => alert.environment === environment && alert.triggeredAt && Date.parse(alert.triggeredAt) > now.getTime() - DAY_MS);
        const filledOrders = await recentFillCount(this.deps.store, environment, now);
        const totalValue = account.totalValue ?? 0;
        // Drift from the same account read, so the digest costs no extra request.
        const saved = await this.deps.targets?.(environment);
        const maxDrift = saved ? allocationDrift(saved, analyzeAllocation(environment, account, dashboard.positions)).maxDrift : undefined;
        const guards = dashboard.positions.map((position) => ({ ticker: position.instrument.ticker, guard: stopProtection(position, dashboard.orders) }));
        const uncovered = guards.some((item) => item.guard) ? guards.filter((item) => !item.guard || item.guard.coverage < 1).map((item) => item.ticker) : [];
        // The day reuses the account read just made; the quote provider's closes may be missing or late.
        const day = dashboard.positions.length ? digestDay(await this.deps.today?.(environment, now).catch(() => undefined)) : undefined;
        // Paid since the last digest that read them (the last day for the first one), and expected from the same read.
        const markKey = `digest-dividends:${environment}`;
        const mark = await this.deps.store.get<DividendMark>(markKey);
        const since = dividendsSince(mark, now);
        const history = await this.deps.dividends?.(environment, new Date(Math.min(since, scheduleStart(now.getTime()))), now).catch(() => undefined);
        const dividends = history
          ? digestDividends(history.items, dashboard.positions, { since, ...(Array.isArray(mark?.seen) ? { seen: mark.seen } : {}), truncated: history.truncated }, now)
          : undefined;
        const text = digestText({
          environment,
          currency: account.currency ?? "",
          totalValue,
          ...(previous === undefined ? {} : { previousTotalValue: previous }),
          cash: account.cash?.availableToTrade ?? 0,
          ...(account.investments?.unrealizedProfitLoss === undefined ? {} : { unrealized: account.investments.unrealizedProfitLoss }),
          positions: dashboard.positions.map((position) => {
            const wallet = position.walletImpact as { unrealizedProfitLoss?: unknown } | undefined;
            return { ticker: position.instrument.ticker, value: positionValue(position), ...(typeof wallet?.unrealizedProfitLoss === "number" ? { profitLoss: wallet.unrealizedProfitLoss } : {}) };
          }),
          pendingOrders: dashboard.orders.length,
          duePlans: plans.map((plan) => plan.label),
          triggeredAlerts: alerts.length,
          filledOrders,
          ...(maxDrift === undefined ? {} : { maxDrift }),
          ...(uncovered.length ? { uncovered } : {}),
          ...(day ? { day } : {}),
          ...(dividends ? { dividends } : {}),
        });
        const event = { id: crypto.randomUUID(), timestamp: now.toISOString(), environment, type: "daily_digest" as const, outcome: text };
        if (!(await this.deps.notify!(event, { force: true }))) {
          // Not delivered: release the day so the next attempt window sends it again.
          await this.deps.store.delete(claimKey);
          continue;
        }
        await this.deps.store.put(`digest-value:${environment}`, totalValue);
        // A read that failed leaves the mark where it was, so the next digest names what this one missed.
        if (history) await this.deps.store.put(markKey, dividendMark(history.items, now));
        await this.deps.trading.recordActivity("daily_digest", environment, { outcome: text }, { notify: false });
        sent.push(environment);
      } catch (error) {
        await this.deps.store.delete(claimKey).catch(() => {});
        console.error(JSON.stringify({ message: "TradePilot digest failed", environment, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return sent;
  }
}
