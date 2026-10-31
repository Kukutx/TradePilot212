import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts.js";
import type { PerformanceSummary } from "../shared/history.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { digestText } from "./digest.js";
import { latestPeriod, PeriodicReports, reportPeriod, reportText } from "./reports.js";
import { MemoryStateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

const summary = (patch: Partial<PerformanceSummary> = {}): PerformanceSummary => ({
  kind: "performance", environment: "demo", accountCurrency: "EUR", period: { from: "2026-10-26", to: "2026-11-02" },
  coverage: { orders: 4, dividends: 1, transactions: 2, truncated: false },
  contributions: { deposits: 500, withdrawals: 0, net: 500 }, income: { dividends: 12.3, interest: 1.2 },
  costs: { total: 0, byType: [] }, realizedProfitLoss: 45, trades: { buys: 3, sells: 1, turnover: 1250 }, byTicker: [],
  valueHistory: [
    { date: "2026-10-26", totalValue: 10000, at: "2026-10-26T20:00:00Z" },
    { date: "2026-11-01", totalValue: 10734.5, at: "2026-11-01T20:00:00Z" },
  ],
  timeWeighted: { return: 0.0234, from: "2026-10-26", to: "2026-11-01", netFlows: 500, series: [] },
  notes: [], timestamp: "2026-11-02T07:00:00Z", ...patch,
});

describe("weekly and monthly reports", () => {
  it("covers the seven days before a Monday and the month before the 1st", () => {
    expect(reportPeriod("weekly", "2026-11-02")).toEqual({ first: "2026-10-26", last: "2026-11-01" });
    expect(reportPeriod("weekly", "2026-11-03")).toBeUndefined();
    expect(reportPeriod("monthly", "2026-03-01")).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(reportPeriod("monthly", "2026-01-01")).toEqual({ first: "2025-12-01", last: "2025-12-31" });
    expect(reportPeriod("monthly", "2026-01-02")).toBeUndefined();
    // The latest that has ended, on any day.
    expect(latestPeriod("weekly", "2026-11-04")).toEqual({ first: "2026-10-26", last: "2026-11-01" });
    expect(latestPeriod("weekly", "2026-11-01")).toEqual({ first: "2026-10-19", last: "2026-10-25" });
    expect(latestPeriod("monthly", "2026-03-15")).toEqual({ first: "2026-02-01", last: "2026-02-28" });
  });

  it("says what the value, flows, income and trades did, in either language", () => {
    const period = { first: "2026-10-26", last: "2026-11-01" };
    expect(reportText("weekly", period, summary()).split(" · ")).toEqual([
      "Last week, 2026-10-26 to 2026-11-01",
      "value 10,734.50 EUR (from 10,000.00 EUR, +734.50 EUR)",
      "time-weighted return +2.34%",
      "net deposits +500.00 EUR",
      "dividends 12.30 EUR, interest 1.20 EUR",
      "3 buy(s), 1 sell(s), turnover 1,250.00 EUR",
      "realized +45.00 EUR",
    ]);
    expect(reportText("monthly", period, summary({ valueHistory: [], contributions: { deposits: 0, withdrawals: 0, net: 0 }, income: { dividends: 0, interest: 0 }, trades: { buys: 0, sells: 0, turnover: 0 }, realizedProfitLoss: 0, coverage: { orders: 0, dividends: 0, transactions: 0, truncated: true } }), "zh-CN"))
      .toBe("上月，2026-10-26 至 2026-11-01 · 时间加权收益 +2.34% · 没有交易 · 历史记录读到页数上限被截断，数字可能偏低");
  });

  it("sends each period's report once, from the digest's hour, and on later days while no endpoint has taken it", async () => {
    const env: RuntimeEnv = { T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", NOTIFY_WEBHOOK_URL: "https://hooks.example/t", DIGEST_HOUR: "8", TIMEZONE: "Europe/London", REPORTS: "weekly,monthly", NOTIFY_LOCALE: "zh-CN" };
    const store = new MemoryStateStore();
    const sent: ActivityEvent[] = [];
    let accept = false;
    const windows: string[] = [];
    const recorded: string[] = [];
    const reports = new PeriodicReports({
      config: createConfig(env), store,
      trading: { recordActivity: async (type: string) => { recorded.push(type); return {}; } } as unknown as TradingService,
      notify: async (event) => { sent.push(event); return accept; },
      performance: async (_environment, window) => { windows.push(`${window.from!.toISOString()}..${window.to.toISOString()}`); return summary(); },
    });
    // Sunday 1 November 2026: the month just ended, and the latest whole week (19 to 25 October); 07:59 in London (GMT) is before the hour.
    expect(await reports.run(new Date("2026-11-01T07:59:00Z"))).toEqual([]);
    expect(await reports.run(new Date("2026-11-01T08:00:00Z"))).toEqual([]);
    // From London's midnight on 1 October (summer time) to just before its midnight on 1 November (winter time).
    expect(windows).toContain("2026-09-30T23:00:00.000Z..2026-10-31T23:59:59.999Z");
    expect(sent.find((event) => event.type === "monthly_report")).toMatchObject({ outcome: expect.stringMatching(/^上月，2026-10-01 至 2026-10-31/) });
    // Not taken: tried again after 15 minutes, not before.
    accept = true;
    expect(await reports.run(new Date("2026-11-01T08:10:00Z"))).toEqual([]);
    expect((await reports.run(new Date("2026-11-01T08:16:00Z"))).sort()).toEqual(["monthly:demo", "weekly:demo"]);
    expect(await reports.run(new Date("2026-11-01T09:00:00Z"))).toEqual([]);
    expect(recorded.sort()).toEqual(["monthly_report", "weekly_report"]);
    // Monday: the week before, sent once.
    expect(await reports.run(new Date("2026-11-02T08:30:00Z"))).toEqual(["weekly:demo"]);
    expect(sent.at(-1)).toMatchObject({ type: "weekly_report", outcome: expect.stringMatching(/^上周，2026-10-26 至 2026-11-01/) });
    // A week no endpoint took on its Monday goes out on Tuesday.
    accept = false;
    expect(await reports.run(new Date("2026-11-09T08:00:00Z"))).toEqual([]);
    accept = true;
    expect(await reports.run(new Date("2026-11-10T08:00:00Z"))).toEqual(["weekly:demo"]);
    expect(await reports.run(new Date("2026-11-11T08:00:00Z"))).toEqual([]);
  });

  it("needs the digest's hour, and knows only weekly and monthly", () => {
    expect(() => createConfig({ REPORTS: "weekly" })).toThrow(/DIGEST_HOUR/);
    expect(() => createConfig({ REPORTS: "daily", DIGEST_HOUR: "7" })).toThrow(/weekly, monthly/);
    expect(createConfig({ REPORTS: "monthly weekly", DIGEST_HOUR_UTC: "7" }).reports).toEqual(["weekly", "monthly"]);
  });
});

describe("the daily digest in Chinese", () => {
  it("writes the same figures in Chinese words", () => {
    const text = digestText({
      environment: "demo", currency: "EUR", totalValue: 1000, previousTotalValue: 990, cash: 50, positions: [{ ticker: "VUSA", value: 600, profitLoss: 20 }],
      pendingOrders: 2, duePlans: ["Core"], triggeredAlerts: 1, filledOrders: 1, maxDrift: 0.031,
      dividends: { received: [{ name: "VUSA", amount: 1.5 }], expected: [{ name: "AAPL", on: "2026-11-04", amount: 0.4, due: false }] },
    }, "zh-CN");
    expect(text.split(" · ")).toEqual([
      "总值 1000 EUR（较上次摘要 +10）", "现金 50", "前三大持仓：VUSA 600（+20）", "2 笔挂单", "到期计划：Core", "过去一天触发 1 个提醒", "过去一天成交 1 笔订单",
      "收到股息 1.5：VUSA 1.5", "本周预计股息：AAPL ~0.4 11-04", "与目标的最大偏离 3.1 个百分点",
    ]);
  });
});
