import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseWindow } from "../../core/insights-service";
import type { PerformanceSummary } from "../../shared/history";
import { createTranslator } from "../i18n";
import { DrawdownChart, DrawdownNote, PerformanceView, periodOf } from "./InsightsView";

describe("the period of a performance window", () => {
  const of = (period: "1m" | "3m" | "ytd" | "1y" | "all", now: string) => {
    const window = parseWindow({ period }, new Date(now));
    return periodOf({ ...(window.from ? { from: window.from.toISOString() } : {}), to: window.to.toISOString() });
  };

  it("reads each window back as the period it was asked for", () => {
    for (const period of ["1m", "3m", "ytd", "1y", "all"] as const) expect(of(period, "2026-10-12T03:00:00Z")).toBe(period);
  });

  it("doesn't take a month or three that happen to start on 1 January for the year to date", () => {
    expect(of("1m", "2027-01-31T00:20:00Z")).toBe("1m");
    expect(of("3m", "2027-04-02T00:40:00Z")).toBe("3m");
  });
});

describe("the performance view's benchmark", () => {
  const twr = { return: 0.244, from: "2026-04-16", to: "2026-10-12", netFlows: -500, series: [{ date: "2026-04-16", return: 0 }, { date: "2026-07-27", return: 0.1096 }, { date: "2026-10-12", return: 0.244 }] };
  const base: PerformanceSummary = {
    kind: "performance", environment: "demo", accountCurrency: "EUR", period: { to: "2026-10-12T12:00:00Z" },
    coverage: { orders: 1, dividends: 1, transactions: 1, truncated: false },
    contributions: { deposits: 14000, withdrawals: 500, net: 13500 }, income: { dividends: 100, interest: 12.6 }, costs: { total: 0.06, byType: [] },
    realizedProfitLoss: 132, trades: { buys: 10, sells: 1, turnover: 1000 }, byTicker: [], notes: [], timestamp: "2026-10-12T12:00:00Z",
    valueHistory: [{ date: "2026-04-16", totalValue: 15000, at: "2026-04-16T20:00:00Z" }, { date: "2026-10-12", totalValue: 18000, at: "2026-10-12T12:00:00Z" }],
    timeWeighted: twr,
    benchmarkOptions: [{ ticker: "VUSAl_EQ", shortName: "VUSA", name: "Vanguard S&P 500 UCITS ETF (Dist)" }, { ticker: "EUNLd_EQ", shortName: "EUNL" }],
  };
  const render = (data: PerformanceSummary, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(PerformanceView, {
    data, locale, t: createTranslator(locale), period: "all", busy: false, onPeriod: () => {}, onBenchmark: () => {},
  }));

  it("draws the benchmark beside the return, names both, and says how far ahead or behind it is", () => {
    const html = render({ ...base, benchmarkChoice: "VUSAl_EQ", benchmark: { ticker: "VUSAl_EQ", shortName: "VUSA", currencyCode: "GBX", source: "stooq", return: 0.115, series: [{ date: "2026-04-16", return: 0 }, { date: "2026-10-12", return: 0.115 }] } });
    expect(html).toContain('class="lineCompare"');
    expect(html).toContain("Your return</li>");
    expect(html).toContain("12.9 points ahead of VUSA");
    expect(html).toContain("VUSA +11.5% over the same days. VUSA is priced in GBX, so currency moves against EUR are not in it.");
    expect(html).toMatch(/<option value="VUSAl_EQ" selected="">VUSA · Vanguard S&amp;P 500 UCITS ETF \(Dist\)<\/option><option value="EUNLd_EQ">EUNL<\/option><option value="none">No comparison<\/option>/);
    expect(render({ ...base, benchmarkChoice: "VUSAl_EQ", benchmark: { ticker: "VUSAl_EQ", shortName: "VUSA", currencyCode: "EUR", source: "stooq", return: 0.3, series: [] } }, "zh-CN")).toContain("跑输 VUSA 5.6 个百分点");
  });

  it("says why there are no gains by instrument", () => {
    expect(render({ ...base, attributionMissing: "period", attributionProblem: "x" })).toContain("need a period that ends now");
    expect(render({ ...base, attributionMissing: "history", attributionProblem: "x" })).toContain("only the most recent was read");
    expect(render({ ...base, attributionMissing: "data", attributionProblem: "429" }, "zh-CN")).toContain("这次没能读到按标的拆分的收益");
  });

  it("says why there is no comparison, and keeps the choice", () => {
    const html = render({ ...base, benchmarkChoice: "EUNLd_EQ", benchmarkMissing: "plan", benchmarkProblem: "Finnhub has no daily prices." });
    expect(html).not.toContain('class="lineCompare"');
    expect(html).toContain("No comparison with EUNL: this quote provider&#x27;s free plan has no daily prices.");
    expect(html).toContain('<option value="EUNLd_EQ" selected="">');
    expect(render(base)).toContain('<option value="none" selected="">');
    const query = render({ ...base, benchmarkChoice: "VWRL", benchmarkMissing: "instrument", benchmarkProblem: "Several match" });
    expect(query).toContain("No comparison with VWRL: it could not be looked up on Trading 212 as one fund");
    expect(query).toContain('<option value="none" selected="">');
  });

  it("calls a fund in pence the account's currency for a GBP account, and a gap under 0.05 points level", () => {
    const html = render({ ...base, accountCurrency: "GBP", benchmarkChoice: "VUSAl_EQ", benchmark: { ticker: "VUSAl_EQ", shortName: "VUSA", currencyCode: "GBX", source: "stooq", return: 0.2442, series: [] } });
    expect(html).toContain("Level with VUSA");
    expect(html).not.toContain("currency moves");
  });
});

describe("the performance view's drawdown", () => {
  const series = [{ date: "2026-09-01", return: 0 }, { date: "2026-09-02", return: 0.1 }, { date: "2026-09-03", return: -0.12 }, { date: "2026-09-04", return: 0.045 }];
  const twr = { return: 0.045, from: "2026-09-01", to: "2026-09-04", netFlows: 0, series, drawdown: { max: -0.2, peak: "2026-09-02", trough: "2026-09-03", current: -0.05, currentPeak: "2026-09-02" } };
  const data = {
    kind: "performance", environment: "demo", accountCurrency: "EUR", period: { to: "2026-09-04T12:00:00Z" }, timeWeighted: twr,
    benchmark: { ticker: "VUSAl_EQ", shortName: "VUSA", source: "stooq", return: 0.02, series: series.map((point, index) => ({ date: point.date, return: [0, -0.05, 0.01, 0.02][index]! })), drawdown: { max: -0.05, peak: "2026-09-01", trough: "2026-09-02", recovered: "2026-09-03", current: 0 } },
  } as PerformanceSummary;

  it("draws each day's fall from the high beside the benchmark's, and says the deepest and where it stands", () => {
    const chart = renderToStaticMarkup(createElement(DrawdownChart, { returns: twr, data, controls: null, locale: "en", t: createTranslator("en") }));
    expect(chart).toContain("<span>Drawdown</span>");
    expect(chart).toContain('class="lineCompare"');
    expect(chart).toContain("Your drawdown</li>");
    // 0.88 against the high of 1.1 is 20% down, the axis's lowest gridline; 1.045 against it 5% down. Zero is the top.
    expect(chart).toContain('aria-label="Drawdown: Sep 1, 2026 At the high, Sep 4, 2026 -5.00%; VUSA At the high"');
    expect(chart).toMatch(/<text x="52" y="148\.\d+" dy="0\.32em" text-anchor="end">-20%<\/text>/);
    expect(chart).toMatch(/<line class="lineZero" x1="60" x2="586" y1="23\.\d+"/);
    const note = renderToStaticMarkup(createElement(DrawdownNote, { returns: twr, data, locale: "en", t: createTranslator("en") }));
    expect(note).toContain('<strong class="negative">-20.0%</strong> · the largest fall from a high, from Sep 2, 2026 to Sep 3, 2026, not made up yet. Now 5.0% below the high of Sep 2, 2026. VUSA&#x27;s largest fall over the same days: -5.0%.');
  });

  it("says when it never fell, in Chinese", () => {
    const flat = { ...twr, drawdown: { max: 0, current: 0 } };
    const note = renderToStaticMarkup(createElement(DrawdownNote, { returns: flat, data: { ...data, timeWeighted: flat }, locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(note).toContain("这 4 天里没有跌破此前的高点。");
    expect(note).toContain("VUSA 同期最大回撤 -5.0%。");
    const calm = { ...data.benchmark!, drawdown: { max: 0, current: 0 } };
    expect(renderToStaticMarkup(createElement(DrawdownNote, { returns: flat, data: { ...data, timeWeighted: flat, benchmark: calm }, locale: "en", t: createTranslator("en") })))
      .toContain("VUSA never fell below an earlier high over the same days.");
  });

  it("keeps a flat line's scale at a percent either side, not a hundred", () => {
    const flat = { ...twr, series: twr.series.map((point) => ({ ...point, return: 0 })), drawdown: { max: 0, current: 0 } };
    const chart = renderToStaticMarkup(createElement(DrawdownChart, { returns: flat, data: { ...data, benchmark: undefined } as PerformanceSummary, controls: null, locale: "en", t: createTranslator("en") }));
    // Below zero only: a fall from a high never rises above it.
    expect(chart).toContain(">-1.0%</text>");
    expect(chart).not.toContain("+1%");
    expect(chart).not.toContain("100%");
  });
});
