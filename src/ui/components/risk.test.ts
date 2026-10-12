import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BenchmarkReturn, TimeWeightedReturn } from "../../shared/history";
import { createTranslator } from "../i18n";
import { moveBins, RiskPanel } from "./risk";

const DAY_MS = 86_400_000;
/** The nth weekday from Monday 5 January 2026. */
const weekdayOf = (index: number) => new Date(Date.UTC(2026, 0, 5) + (Math.floor(index / 5) * 7 + (index % 5)) * DAY_MS).toISOString().slice(0, 10);

describe("daily move bars", () => {
  it("counts the moves into bars of the smallest width that keeps to 16, never straddling 0", () => {
    const moves = [-0.012, -0.004, 0.001, 0.003, 0.0049, 0.011].map((value, index) => ({ date: weekdayOf(index), return: value }));
    const { width, bins } = moveBins(moves)!;
    // 0.25% bars would run from -1.25% to +1.25%: 10 of them. They fit.
    expect(width).toBe(0.0025);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ from: -0.0125, to: -0.01, count: 1 });
    expect(bins.find((bin) => bin.from === 0)).toEqual({ from: 0, to: 0.0025, count: 1 });
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(6);
    // A wide spread takes wider bars.
    expect(moveBins([{ date: weekdayOf(0), return: -0.09 }, { date: weekdayOf(1), return: 0.08 }])!.width).toBe(0.02);
    expect(moveBins([])).toBeUndefined();
  });

  it("puts a rise past 16 of the widest bars in the last one", () => {
    const { width, bins } = moveBins([{ date: weekdayOf(0), return: -0.02 }, { date: weekdayOf(1), return: 3 }, { date: weekdayOf(2), return: 25 }])!;
    expect(width).toBe(0.1);
    expect(bins).toHaveLength(16);
    expect(bins.at(-1)).toMatchObject({ count: 2, over: true });
    expect(bins.at(-1)!.from).toBeCloseTo(1.4, 9);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3);
  });
});

describe("risk panel", () => {
  const series = [{ date: weekdayOf(0), return: 0 }];
  for (let day = 1; day <= 31; day++) series.push({ date: weekdayOf(day), return: series[day - 1]!.return + (day === 31 ? -0.05 : day % 3 === 0 ? -0.006 : 0.004) });
  const returns: TimeWeightedReturn = {
    return: series[31]!.return, from: weekdayOf(0), to: weekdayOf(31), netFlows: 0, series,
    // Read up to the day before the last: that one is today.
    risk: { from: weekdayOf(0), to: weekdayOf(30), stretches: 30, days: 30, volatility: 0.083, up: 20, down: 10, best: { date: "2026-01-06", return: 0.004 }, worst: { date: "2026-01-08", return: -0.0059 } },
  };
  const benchmark: BenchmarkReturn = { ticker: "VUSAl_EQ", shortName: "VUSA", source: "sample", return: 0.02, series, risk: { volatility: 0.12, beta: 0.61, correlation: 0.84 } };

  it("gives the volatility, beta, best and worst days, and the daily moves", () => {
    const html = renderToStaticMarkup(createElement(RiskPanel, { returns, benchmark, locale: "en", t: createTranslator("en") }));
    expect(html).toContain("<span>Volatility a year</span><strong>8.3%</strong><small>VUSA: 12.0%</small>");
    expect(html).toContain("<span>Beta to VUSA</span><strong>0.61</strong><small>Correlation 0.84</small>");
    expect(html).toContain('<span>Worst day</span><strong class="negative">-0.59%</strong><small>Jan 8</small>');
    expect(html).toContain("<strong>20 of 30</strong><small>67% of the days it moved</small>");
    // Under a year: no return over volatility, and the note says when it comes.
    expect(html).not.toContain("<span>Return ÷ volatility</span>");
    expect(html).toContain("Return ÷ volatility shows once a year is recorded.");
    // Each bar says its range and count; today's fall of 5% is not one of them.
    expect(html).toMatch(/class="moveColumn up" title="\+0\.25% – \+0\.50%: 20 days"/);
    expect(html).toMatch(/class="moveColumn down" title="-0\.75% – -0\.50%: 10 days"/);
    expect(html).not.toContain("-5.00%");
    expect(html).toContain("most often");
  });

  it("says one day in the singular", () => {
    const one = [{ date: weekdayOf(0), return: 0 }, ...Array.from({ length: 21 }, (_, index) => ({ date: weekdayOf(index + 1), return: index ? 0.01 : 0.02 }))];
    const html = renderToStaticMarkup(createElement(RiskPanel, { returns: { ...returns, series: one, risk: { ...returns.risk!, to: weekdayOf(21) } }, locale: "en", t: createTranslator("en") }));
    // A rise of 2% and a fall of about 1%, then no moves.
    expect(html).toContain('title="+2.00% – +2.25%: 1 day"');
  });

  it("leaves the benchmark out without one, in Chinese", () => {
    const html = renderToStaticMarkup(createElement(RiskPanel, { returns, locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(html).toContain("年化波动率");
    expect(html).not.toContain("Beta");
    expect(html).toContain("每日涨跌分布");
    expect(html).toContain("单日最大跌幅");
    // Chinese sentences run on without a space.
    expect(renderToStaticMarkup(createElement(RiskPanel, { returns, benchmark, locale: "zh-CN", t: createTranslator("zh-CN") }))).toContain("不计入天数和图表。记录满一年后才显示收益 ÷ 波动。Beta 表示 VUSA");
  });
});
