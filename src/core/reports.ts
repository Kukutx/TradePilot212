// Weekly and monthly account reports (REPORTS=weekly,monthly), sent at the digest's hour: on Monday for the seven days
// before, on the 1st for the month before. Each says what the account's value did over the period, its time-weighted
// return when TradePilot recorded the days, the money put in or taken out, dividends and interest, the trades and
// realized gains, and the costs, in NOTIFY_LOCALE's language. They only read; a period counts as reported only once a
// notification endpoint accepted it, and is tried again every 15 minutes for the rest of the day until then.

import { REPORT_KINDS, type ReportKind } from "../shared/automation.js";
import type { TradingEnvironment } from "../shared/contracts.js";
import type { PerformanceSummary } from "../shared/history.js";
import { localDay, localHour, localMidnight } from "../shared/time-zone.js";
import type { HistoryWindow } from "./analytics.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { Notifier, NotifyLocale } from "./notify.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

export { REPORT_KINDS, type ReportKind };

const DAY_MS = 86_400_000;
const RETRY_MS = 15 * 60_000;

const addDays = (day: string, days: number) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};
const midnight = (day: string, timeZone: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return localMidnight(year, month, date, timeZone);
};

/**
 * The period a report sent on `day` (YYYY-MM-DD, in the digest's zone) covers, when one is due that day: the seven days
 * before a Monday, or the month before the 1st. `first` and `last` are its first and last whole days.
 */
export function reportPeriod(kind: ReportKind, day: string): { first: string; last: string } | undefined {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (kind === "weekly") return weekday === 1 ? { first: addDays(day, -7), last: addDays(day, -1) } : undefined;
  if (!day.endsWith("-01")) return undefined;
  const last = addDays(day, -1);
  return { first: `${last.slice(0, 8)}01`, last };
}

const REPORT_WORDS = {
  en: {
    period: (kind: ReportKind, first: string, last: string) => `${kind === "weekly" ? "Last week" : "Last month"}, ${first} to ${last}`,
    value: (end: string, start: string, change: string) => `value ${end} (from ${start}, ${change})`,
    twr: (value: string) => `time-weighted return ${value}`,
    flows: (value: string) => `net deposits ${value}`,
    income: (dividends: string, interest: string | undefined) => `dividends ${dividends}${interest ? `, interest ${interest}` : ""}`,
    interest: (value: string) => `interest ${value}`,
    trades: (buys: number, sells: number, turnover: string) => `${buys} buy(s), ${sells} sell(s), turnover ${turnover}`,
    noTrades: "no trades",
    realized: (value: string) => `realized ${value}`,
    costs: (value: string) => `costs ${value}`,
    short: "history cut short at the page limit: figures may be low",
  },
  "zh-CN": {
    period: (kind: ReportKind, first: string, last: string) => `${kind === "weekly" ? "上周" : "上月"}，${first} 至 ${last}`,
    value: (end: string, start: string, change: string) => `市值 ${end}（期初 ${start}，${change}）`,
    twr: (value: string) => `时间加权收益 ${value}`,
    flows: (value: string) => `净入金 ${value}`,
    income: (dividends: string, interest: string | undefined) => `股息 ${dividends}${interest ? `，利息 ${interest}` : ""}`,
    interest: (value: string) => `利息 ${value}`,
    trades: (buys: number, sells: number, turnover: string) => `买入 ${buys} 笔，卖出 ${sells} 笔，成交额 ${turnover}`,
    noTrades: "没有交易",
    realized: (value: string) => `已实现盈亏 ${value}`,
    costs: (value: string) => `费用 ${value}`,
    short: "历史记录读到页数上限被截断，数字可能偏低",
  },
} as const;

/** The report as " · " parts, as the digest is: each part is a line where the service lays out lines. */
export function reportText(kind: ReportKind, period: { first: string; last: string }, summary: PerformanceSummary, locale: NotifyLocale = "en"): string {
  const words = REPORT_WORDS[locale];
  const currency = summary.accountCurrency;
  const money = (value: number, sign = false) => {
    const text = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...(sign ? { signDisplay: "exceptZero" as const } : {}) }).format(value);
    return currency ? `${text} ${currency}` : text;
  };
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(value);
  const values = summary.valueHistory ?? [];
  const start = values[0];
  const end = values.at(-1);
  const flows = summary.contributions.net;
  const { dividends, interest } = summary.income;
  const { buys, sells, turnover } = summary.trades;
  return [
    words.period(kind, period.first, period.last),
    start && end && start !== end ? words.value(money(end.totalValue), money(start.totalValue), money(end.totalValue - start.totalValue, true)) : undefined,
    summary.timeWeighted ? words.twr(percent(summary.timeWeighted.return)) : undefined,
    Math.abs(flows) >= 0.005 ? words.flows(money(flows, true)) : undefined,
    Math.abs(dividends) >= 0.005 ? words.income(money(dividends), Math.abs(interest) >= 0.005 ? money(interest) : undefined)
      : Math.abs(interest) >= 0.005 ? words.interest(money(interest)) : undefined,
    buys || sells ? words.trades(buys, sells, money(turnover)) : words.noTrades,
    Math.abs(summary.realizedProfitLoss) >= 0.005 ? words.realized(money(summary.realizedProfitLoss, true)) : undefined,
    Math.abs(summary.costs.total) >= 0.005 ? words.costs(money(summary.costs.total)) : undefined,
    summary.coverage.truncated ? words.short : undefined,
  ].filter(Boolean).join(" · ");
}

export class PeriodicReports {
  constructor(private readonly deps: {
    config: RuntimeConfig; store: StateStore; trading: TradingService; notify?: Notifier;
    /** The account's performance over a window, with the values TradePilot recorded in it. */
    performance: (environment: TradingEnvironment, window: HistoryWindow) => Promise<PerformanceSummary>;
  }) {}

  /** Each report due today, once per environment, at or after the digest's hour. Returns `kind:environment` for each sent. */
  async run(now = new Date()): Promise<string[]> {
    const { digest, reports } = this.deps.config;
    if (!digest || !reports.length || !this.deps.notify || localHour(now.getTime(), digest.timeZone) < digest.hour) return [];
    const day = localDay(now.getTime(), digest.timeZone);
    const credentials = credentialStatus(this.deps.config);
    const sent: string[] = [];
    for (const kind of reports) {
      const period = reportPeriod(kind, day);
      if (!period) continue;
      for (const environment of ["demo", "live"] as const) {
        if (!credentials[environment]) continue;
        // A failed attempt is tried again every 15 minutes for the rest of the day.
        const attempt = await this.deps.store.increment(`report-try:${kind}:${environment}:${day}`, RETRY_MS, now.getTime());
        if (attempt.count > 1) continue;
        const claimKey = `report:${kind}:${environment}:${day}`;
        const claim = await this.deps.store.increment(claimKey, 2 * DAY_MS, now.getTime());
        if (claim.count > 1) continue;
        let delivered = false;
        try {
          const window: HistoryWindow = { from: new Date(midnight(period.first, digest.timeZone)), to: new Date(midnight(day, digest.timeZone)), endsNow: false };
          const summary = await this.deps.performance(environment, window);
          const text = reportText(kind, period, summary, this.deps.config.notifyLocale);
          const type = kind === "weekly" ? "weekly_report" as const : "monthly_report" as const;
          const event = { id: crypto.randomUUID(), timestamp: now.toISOString(), environment, type, outcome: text };
          if (!(await this.deps.notify(event, { force: true }))) {
            await this.deps.store.delete(claimKey);
            continue;
          }
          delivered = true;
          sent.push(`${kind}:${environment}`);
          await this.deps.trading.recordActivity(type, environment, { outcome: text }, { notify: false }).catch(() => undefined);
        } catch (error) {
          if (!delivered) await this.deps.store.delete(claimKey).catch(() => {});
          console.error(JSON.stringify({ message: "TradePilot report failed", kind, environment, error: error instanceof Error ? error.message : String(error) }));
        }
      }
    }
    return sent;
  }
}
