import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseWindow } from "../../core/insights-service";
import type { PerformanceSummary } from "../../shared/history";
import { createTranslator } from "../i18n";
import { PerformanceView, periodOf } from "./InsightsView";

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
