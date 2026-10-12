import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AllocationAnalysis, HoldingMix } from "../../shared/history";
import { createTranslator } from "../i18n";
import { AllocationView } from "../views/InsightsView";
import { HoldingMixPanel } from "./holding-mix";

const mix: HoldingMix = {
  value: 6000, return: 0.12, up: 30, counted: 51, badWeek: -0.034, badWeeks: -0.041,
  series: [{ date: "2025-10-10", return: 0 }, { date: "2025-10-17", return: 0.02 }, { date: "2025-10-24", return: -0.03 }, { date: "2026-10-09", return: 0.12 }],
  worst: { date: "2026-04-03", return: -0.052 }, best: { date: "2025-11-14", return: 0.044 },
  drawdown: { max: -0.098, peak: "2026-02-13", trough: "2026-04-03", recovered: "2026-05-29", current: 0 },
};
const render = (data: HoldingMix, locale: "en" | "zh-CN" = "en") =>
  renderToStaticMarkup(createElement(HoldingMixPanel, { mix: data, currency: "EUR", locale, t: createTranslator(locale) }));

describe("today's mix over the year", () => {
  it("gives the return, a bad week in percent and in money, the worst week and the deepest fall", () => {
    const html = render(mix);
    expect(html).toContain("Today&#x27;s mix over the year");
    expect(html).toContain('<span>Return</span><strong class="positive">+12.0%</strong><small>Up in 30 of 51 weeks</small>');
    // 3.4% of the 6,000 measured.
    expect(html).toContain('<span>A bad week, 1 in 20</span><strong class="negative">-3.4%</strong><small>About €204 of today&#x27;s €6,000 measured; -4.1% on average in those weeks</small>');
    expect(html).toContain('<span>Worst week</span><strong class="negative">-5.2%</strong><small>To Apr 3, 2026; best +4.4% to Nov 14, 2025</small>');
    expect(html).toContain('<span>Deepest fall</span><strong class="negative">-9.8%</strong><small>Feb 13, 2026 to Apr 3, 2026, made up by May 29, 2026</small>');
    expect(html).toContain("not the most it can lose");
  });

  it("puts no figure on a bad week when even the worst one in 20 rose", () => {
    const html = render({ ...mix, badWeek: 0.0019, badWeeks: -0.012 });
    expect(html).toContain("<span>A bad week, 1 in 20</span><strong>No fall</strong><small>It fell in fewer than 1 week in 20; that week +0.2%</small>");
    expect(html).not.toContain("About €");
    // A fall that one decimal would show as 0.0% gets two.
    expect(render({ ...mix, badWeek: -0.0003 })).toContain('<strong class="negative">-0.03%</strong>');
  });

  it("says when the fall is not made up, or there was none, in Chinese too", () => {
    const open = render({ ...mix, drawdown: { max: -0.098, peak: "2026-02-13", trough: "2026-04-03", current: -0.05, currentPeak: "2026-02-13" } });
    expect(open).toContain("Feb 13, 2026 to Apr 3, 2026, not made up yet");
    expect(render({ ...mix, drawdown: { max: 0, current: 0 } })).toContain("<span>Deepest fall</span><strong>0.0%</strong><small>It never fell from a high</small>");
    const zh = render(mix, "zh-CN");
    expect(zh).toContain("当前持仓回看一年");
    expect(zh).toContain("<span>20 周一遇的糟糕周</span>");
    expect(zh).toContain("2026年2月13日 至 2026年4月3日，2026年5月29日 已收复");
  });

  it("leaves it out of an allocation read before it existed", () => {
    const risk = {
      from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.16, diversification: 1.3, covered: 1,
      rows: [{ ticker: "A", weight: 0.5, volatility: 0.2, risk: 0.6, correlation: 0.9 }, { ticker: "B", weight: 0.5, volatility: 0.2, risk: 0.4, correlation: 0.8 }],
      correlations: { tickers: ["A", "B"], matrix: [[1, 0.5], [0.5, 1]] },
    };
    const data = {
      kind: "allocation", environment: "demo", accountCurrency: "EUR", totalValue: 2000, investedValue: 2000, cash: 0, cashWeight: 0,
      holdings: [{ ticker: "A", name: "A", currency: "USD", value: 1000, weight: 0.5 }, { ticker: "B", name: "B", currency: "USD", value: 1000, weight: 0.5 }],
      byCurrency: [], byType: [], concentration: { largestWeight: 0.5, top5Weight: 1, herfindahl: 0.5, effectiveHoldings: 2 }, flags: [], risk,
    } as unknown as AllocationAnalysis;
    const html = renderToStaticMarkup(createElement(AllocationView, { data, locale: "en", t: createTranslator("en") }));
    expect(html).toContain("Risk by holding");
    expect(html).not.toContain("Today&#x27;s mix");
  });
});
