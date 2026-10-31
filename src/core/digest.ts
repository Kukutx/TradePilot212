// A once-a-day account digest sent to the notification webhook at DIGEST_HOUR (in TIMEZONE) or DIGEST_HOUR_UTC, in
// NOTIFY_LOCALE's language, so you can follow the account without opening a chat. It only reads; it never trades. It is sent whatever
// NOTIFY_EVENTS lists, and a day counts as done only once the webhook accepted it.

import type { Position, TradingEnvironment } from "../shared/contracts.js";
import type { HistoryDividendItem } from "../shared/history.js";
import { stopProtection } from "../shared/protection.js";
import { symbolFromTicker } from "../shared/ticker.js";
import { localDay, localHour } from "../shared/time-zone.js";
import type { AccountAlert, DcaPlan, PriceAlert, TargetAllocation } from "../shared/automation.js";
import type { PortfolioToday } from "../shared/today.js";
import { analyzeAllocation, expectedDividends, positionValue } from "./analytics.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { Notifier, NotifyLocale } from "./notify.js";
import { monthStart, scheduleStart } from "./dividends.js";
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

/**
 * Where the next digest names dividends from: when the last digest with dividends read them and the payments dated in
 * the few days before that it had seen, or, until one has, where the first digest started.
 */
export interface DividendMark { at?: string; seen?: string[]; from?: string }

/** A payment's identity in the history: Trading 212's reference, or what it paid and when. */
const dividendKey = (item: HistoryDividendItem) => item.reference ?? `${item.ticker ?? item.instrument?.ticker}|${item.paidOn}|${item.amount}`;

/**
 * Where the digest names dividends received from: a little before the last digest that read them, else where the first
 * digest started (`known` false when nothing says, and it is the last day).
 */
export function dividendsSince(mark: DividendMark | undefined, now: Date): { since: number; known: boolean } {
  const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);
  // A mark from a clock ahead of this one counts as now.
  const at = Math.min(time(mark?.at), now.getTime());
  const from = time(mark?.from);
  const oldest = now.getTime() - MAX_DIVIDEND_LOOKBACK_MS;
  if (Number.isFinite(at)) return { since: Math.max(at - LATE_DIVIDEND_MS, oldest), known: true };
  if (from <= now.getTime()) return { since: Math.max(from, oldest), known: true };
  return { since: now.getTime() - DAY_MS, known: false };
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
 * The digest's dividends from the dividend history (read from the first day of the month a week ago, a year before, as
 * the income summary's expected dividends are). Received: each instrument's payments dated after `since` that the last
 * digest had not seen, largest first; one that reached the history late is named by the next digest after it appears.
 * Expected: the payments the holdings are expected to make in the coming seven days, soonest first, then any due in the
 * last seven days and not paid yet; none when the history read stopped short of the year they are read from.
 */
export function digestDividends(dividends: HistoryDividendItem[], positions: Position[], window: { since: number; seen?: string[]; truncated?: boolean }, now: Date, timeZone = "UTC"): DigestDividends {
  // A Trading 212 position has no short name; the symbol is read from its ticker.
  const names = new Map(positions.map((position) => [position.instrument.ticker, position.instrument.shortName || symbolFromTicker(position.instrument.ticker)]));
  const seen = new Set(window.seen ?? []);
  const received = new Map<string, number>();
  for (const item of dividends) {
    const at = Date.parse(item.paidOn ?? "");
    const ticker = item.ticker ?? item.instrument?.ticker;
    if (!ticker || !item.amount || !(at > window.since && at <= now.getTime()) || seen.has(dividendKey(item))) continue;
    received.set(ticker, (received.get(ticker) ?? 0) + item.amount);
  }
  // Whole days, today being the digest's own (in its time zone): the seven before it, it, and the six after it. Stepped
  // from the first of this month when that is earlier, the year's amount is shared over the same payments as on the
  // Income tab's calendar.
  const today = Date.parse(`${localDay(now.getTime(), timeZone)}T00:00:00Z`);
  const day = new Date(today).toISOString().slice(0, 10);
  const weekAgo = new Date(today - WEEK_MS).toISOString().slice(0, 10);
  const upcoming = window.truncated ? [] : expectedDividends(dividends, positions, Math.min(monthStart(today), today - WEEK_MS), today + WEEK_MS, now);
  const expected = upcoming.filter((payment) => payment.on >= weekAgo)
    .map((payment) => ({ name: names.get(payment.ticker) ?? payment.ticker, on: payment.on, amount: payment.amount, due: payment.on < day }));
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

/** The digest's words, in English or Chinese (NOTIFY_LOCALE); the figures are written the same in both. */
const DIGEST_WORDS = {
  en: {
    total: (value: string, change: string | undefined) => `Total ${value}${change ? ` (${change} since the last digest)` : ""}`,
    day: (amount: string, change: string | undefined, days: string, part: string | undefined) => `day ${amount}${change ? ` (${change})` : ""} on ${days}${part ? ` for ${part} instruments` : ""}`,
    part: (counted: number, of: number) => `${counted} of ${of}`,
    movers: (list: string) => `movers: ${list}`,
    cash: (value: string) => `cash ${value}`,
    unrealized: (value: string) => `unrealized ${value}`,
    top: (list: string) => `top: ${list}`,
    pending: (count: number) => `${count} pending order(s)`,
    plans: (list: string) => `due plans: ${list}`,
    alerts: (count: number) => `${count} alert(s) triggered in the last day`,
    fills: (count: number) => `${count} order(s) filled in the last day`,
    received: (sum: string, list: string) => `dividends ${sum} in: ${list}`,
    expected: (list: string) => `dividends expected this week: ${list}`,
    due: (on: string) => `due ${on}`,
    drift: (points: string) => `largest drift from targets ${points} points`,
    uncovered: (list: string) => `no full stop-loss: ${list}`,
    join: ", ",
  },
  "zh-CN": {
    total: (value: string, change: string | undefined) => `总值 ${value}${change ? `（较上次摘要 ${change}）` : ""}`,
    day: (amount: string, change: string | undefined, days: string, part: string | undefined) => `当日 ${amount}${change ? `（${change}）` : ""}，交易日 ${days}${part ? `，按 ${part} 个标的计` : ""}`,
    part: (counted: number, of: number) => `${counted}/${of}`,
    movers: (list: string) => `涨跌最大：${list}`,
    cash: (value: string) => `现金 ${value}`,
    unrealized: (value: string) => `未实现盈亏 ${value}`,
    top: (list: string) => `前三大持仓：${list}`,
    pending: (count: number) => `${count} 笔挂单`,
    plans: (list: string) => `到期计划：${list}`,
    alerts: (count: number) => `过去一天触发 ${count} 个提醒`,
    fills: (count: number) => `过去一天成交 ${count} 笔订单`,
    received: (sum: string, list: string) => `收到股息 ${sum}：${list}`,
    expected: (list: string) => `本周预计股息：${list}`,
    due: (on: string) => `已到期 ${on}`,
    drift: (points: string) => `与目标的最大偏离 ${points} 个百分点`,
    uncovered: (list: string) => `未被止损完全覆盖：${list}`,
    join: "，",
  },
} as const;

/** Plain-text digest; kept short so it reads well in a chat notification. */
export function digestText(input: DigestInput, locale: NotifyLocale = "en"): string {
  const words = DIGEST_WORDS[locale];
  const change = input.previousTotalValue === undefined ? undefined : signed(input.totalValue - input.previousTotalValue);
  const top = [...input.positions].sort((a, b) => b.value - a.value).slice(0, 3)
    .map((item) => `${item.ticker} ${round(item.value)}${item.profitLoss === undefined ? "" : ` (${signed(item.profitLoss)})`}`);
  const day = input.day;
  const more = (count: number, shown: number) => (count > shown ? ` +${count - shown}` : "");
  return [
    words.total(`${round(input.totalValue)} ${input.currency}`, change),
    day ? words.day(signed(day.profitLoss), day.change === undefined ? undefined : signedPct(day.change), day.days.join(", "), day.counted < day.of ? words.part(day.counted, day.of) : undefined) : undefined,
    // One sold out on the day has no price to compare: its sells' amount instead.
    day?.movers.length ? words.movers(day.movers.map((mover) => `${mover.name} ${mover.change === undefined ? `${signed(mover.profitLoss)} ${input.currency}`.trim() : signedPct(mover.change)}`).join(words.join)) : undefined,
    words.cash(String(round(input.cash))),
    input.unrealized === undefined ? undefined : words.unrealized(signed(input.unrealized)),
    top.length ? words.top(top.join(words.join)) : undefined,
    input.pendingOrders ? words.pending(input.pendingOrders) : undefined,
    input.duePlans.length ? words.plans(input.duePlans.join(words.join)) : undefined,
    input.triggeredAlerts ? words.alerts(input.triggeredAlerts) : undefined,
    input.filledOrders ? words.fills(input.filledOrders) : undefined,
    input.dividends?.received.length
      ? words.received(String(round(input.dividends.received.reduce((sum, item) => sum + item.amount, 0))),
        `${input.dividends.received.slice(0, RECEIVED_DIVIDENDS).map((item) => `${item.name} ${round(item.amount)}`).join(words.join)}${more(input.dividends.received.length, RECEIVED_DIVIDENDS)}`)
      : undefined,
    input.dividends?.expected.length
      ? words.expected(`${input.dividends.expected.slice(0, EXPECTED_DIVIDENDS).map((item) => `${item.name} ~${round(item.amount)} ${item.due ? words.due(item.on.slice(5)) : item.on.slice(5)}`).join(words.join)}${more(input.dividends.expected.length, EXPECTED_DIVIDENDS)}`)
      : undefined,
    input.maxDrift === undefined ? undefined : words.drift((input.maxDrift * 100).toFixed(1)),
    input.uncovered?.length ? words.uncovered(`${input.uncovered.slice(0, 5).join(words.join)}${more(input.uncovered.length, 5)}`) : undefined,
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

  /** Send at most one digest per environment per day in the digest's time zone, at or after its hour. */
  async run(now = new Date()): Promise<string[]> {
    const digest = this.deps.config.digest;
    if (!digest || !this.deps.notify || localHour(now.getTime(), digest.timeZone) < digest.hour) return [];
    const day = localDay(now.getTime(), digest.timeZone);
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
      let delivered = false;
      try {
        // Dividends are named from the last digest that read them, else from where the first one started (the last
        // day), which is kept at once, so a first day whose digest fails, or never goes out, is caught up.
        const markKey = `digest-dividends:${environment}`;
        const mark = await this.deps.store.get<DividendMark>(markKey);
        const { since, known } = dividendsSince(mark, now);
        if (!known) await this.deps.store.put(markKey, { from: new Date(since).toISOString() } satisfies DividendMark);
        const dashboard = await this.deps.trading.getDashboard(environment);
        const account = dashboard.account;
        if (!account) {
          await this.deps.store.delete(claimKey);
          continue;
        }
        const previous = await this.deps.store.get<number>(`digest-value:${environment}`);
        const plans = (await this.deps.store.list<DcaPlan>("plan:")).map((entry) => entry.value)
          .filter((plan) => plan.environment === environment && !plan.paused && Date.parse(plan.nextRunAt) <= now.getTime());
        // Price and account alerts that fired in the last day, armed again since or not.
        const recent = (time?: string) => time !== undefined && Date.parse(time) > now.getTime() - DAY_MS;
        const alerts = [...await this.deps.store.list<PriceAlert>("alert:"), ...await this.deps.store.list<AccountAlert>("account-alert:")].map((entry) => entry.value)
          .filter((alert) => alert.environment === environment && (recent(alert.triggeredAt) || recent(alert.lastTriggeredAt)));
        const filledOrders = await recentFillCount(this.deps.store, environment, now);
        const totalValue = account.totalValue ?? 0;
        // Drift from the same account read, so the digest costs no extra request.
        const saved = await this.deps.targets?.(environment);
        const maxDrift = saved ? allocationDrift(saved, analyzeAllocation(environment, account, dashboard.positions)).maxDrift : undefined;
        const guards = dashboard.positions.map((position) => ({ ticker: position.instrument.ticker, guard: stopProtection(position, dashboard.orders) }));
        const uncovered = guards.some((item) => item.guard) ? guards.filter((item) => !item.guard || item.guard.coverage < 1).map((item) => item.ticker) : [];
        // The day reuses the account read just made; the quote provider's closes may be missing or late.
        const day = dashboard.positions.length ? digestDay(await this.deps.today?.(environment, now).catch(() => undefined)) : undefined;
        // Paid since then, and expected from the same read: the schedules from the first day of last week's month a year ago.
        const history = await this.deps.dividends?.(environment, new Date(Math.min(since, scheduleStart(now.getTime() - WEEK_MS))), now).catch(() => undefined);
        const dividends = history
          ? digestDividends(history.items, dashboard.positions, { since, ...(Array.isArray(mark?.seen) ? { seen: mark.seen } : {}), truncated: history.truncated }, now, digest.timeZone)
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
        }, this.deps.config.notifyLocale);
        const event = { id: crypto.randomUUID(), timestamp: now.toISOString(), environment, type: "daily_digest" as const, outcome: text };
        if (!(await this.deps.notify!(event, { force: true }))) {
          // Not delivered: release the day so the next attempt window sends it again.
          await this.deps.store.delete(claimKey);
          continue;
        }
        // Delivered: the day is done even if what follows fails, so it is not sent twice, and each record is kept apart.
        delivered = true;
        sent.push(environment);
        const keep = (what: string, write: Promise<unknown>) => write.catch((error: unknown) => {
          console.error(JSON.stringify({ message: `TradePilot digest sent; its ${what} was not saved`, environment, error: error instanceof Error ? error.message : String(error) }));
        });
        // A read that failed leaves the mark where it was, so the next digest names what this one missed.
        if (history) await keep("dividend mark", this.deps.store.put(markKey, dividendMark(history.items, now)));
        await keep("value", this.deps.store.put(`digest-value:${environment}`, totalValue));
        await keep("activity entry", this.deps.trading.recordActivity("daily_digest", environment, { outcome: text }, { notify: false }));
      } catch (error) {
        if (!delivered) await this.deps.store.delete(claimKey).catch(() => {});
        console.error(JSON.stringify({ message: "TradePilot digest failed", environment, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return sent;
  }
}
