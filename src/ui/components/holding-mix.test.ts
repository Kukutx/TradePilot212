import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HoldingRisk } from "../../shared/history";
import { createTranslator } from "../i18n";
import { HoldingMixPanel } from "./holding-mix";

const risk: HoldingRisk = {
  from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.164, diversification: 1.38, covered: 1,
  rows: [{ ticker: "AAPL_US_EQ", weight: 1, volatility: 0.2, risk: 1, correlation: 1 }],
  correlations: { tickers: ["AAPL_US_EQ"], matrix: [[1]] },
  mix: {
    value: 6000, return: 0.12, up: 30, badWeek: -0.034, badWeeks: -0.041,
    series: [{ date: "2025-10-10", return: 0 }, { date: "2025-10-17", return: 0.02 }, { date: "2025-10-24", return: -0.03 }, { date: "2026-10-09", return: 0.12 }],
    worst: { date: "2026-04-03", return: -0.052 }, best: { date: "2025-11-14", return: 0.044 },
    drawdown: { max: -0.098, peak: "2026-02-13", trough: "2026-04-03", recovered: "2026-05-29", current: 0 },
  },
};
const render = (data: HoldingRisk, locale: "en" | "zh-CN" = "en") =>
  renderToStaticMarkup(createElement(HoldingMixPanel, { risk: data, currency: "EUR", locale, t: createTranslator(locale) }));

describe("today's mix over the year", () => {
  it("gives the return, a bad week in percent and in money, the worst week and the deepest fall", () => {
    const html = render(risk);
    expect(html).toContain("Today&#x27;s mix over the year");
    expect(html).toContain('<span>Return</span><strong class="positive">+12.0%</strong><small>Up in 30 of 52 weeks</small>');
    // 3.4% of the 6,000 measured.
    expect(html).toContain('<span>A bad week, 1 in 20</span><strong class="negative">-3.4%</strong><small>About €204 today; -4.1% on average in those weeks</small>');
    expect(html).toContain('<span>Worst week</span><strong class="negative">-5.2%</strong><small>To Apr 3, 2026; best +4.4% to Nov 14, 2025</small>');
    expect(html).toContain('<span>Deepest fall</span><strong class="negative">-9.8%</strong><small>Feb 13, 2026 to Apr 3, 2026, made up by May 29, 2026</small>');
    expect(html).toContain("not the most it can lose");
  });

  it("says when the fall is not made up, or there was none, in Chinese too", () => {
    const open = render({ ...risk, mix: { ...risk.mix, drawdown: { max: -0.098, peak: "2026-02-13", trough: "2026-04-03", current: -0.05, currentPeak: "2026-02-13" } } });
    expect(open).toContain("Feb 13, 2026 to Apr 3, 2026, not made up yet");
    const none = { ...risk, mix: { ...risk.mix, drawdown: { max: 0, current: 0 } } };
    expect(render(none)).toContain("<span>Deepest fall</span><strong>0.0%</strong><small>It never fell from a high</small>");
    const zh = render(risk, "zh-CN");
    expect(zh).toContain("当前持仓回看一年");
    expect(zh).toContain("<span>20 周一遇的糟糕周</span>");
    expect(zh).toContain("2026年2月13日 至 2026年4月3日，2026年5月29日 已收复");
  });
});
