import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BenchmarkReturn, TimeWeightedReturn } from "../../shared/history";
import { createTranslator } from "../i18n";
import { moveBins, RiskPanel } from "./risk";

const DAY_MS = 86_400_000;
const dateOf = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY_MS).toISOString().slice(0, 10);

describe("daily move bars", () => {
  it("counts the moves into bars of the smallest width that keeps to 16, never straddling 0", () => {
    const moves = [-0.012, -0.004, 0.001, 0.003, 0.0049, 0.011].map((value, index) => ({ date: dateOf(index), return: value }));
    const { width, bins } = moveBins(moves)!;
    // 0.25% bars would run from -1.25% to +1.25%: 10 of them. They fit.
    expect(width).toBe(0.0025);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ from: -0.0125, to: -0.01, count: 1 });
    expect(bins.find((bin) => bin.from === 0)).toEqual({ from: 0, to: 0.0025, count: 1 });
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(6);
    // A wide spread takes wider bars.
    expect(moveBins([{ date: dateOf(0), return: -0.09 }, { date: dateOf(1), return: 0.08 }])!.width).toBe(0.02);
    expect(moveBins([])).toBeUndefined();
  });
});

describe("risk panel", () => {
  const series = [{ date: dateOf(0), return: 0 }];
  for (let day = 1; day <= 30; day++) series.push({ date: dateOf(day), return: series[day - 1]!.return + (day % 3 === 0 ? -0.006 : 0.004) });
  const returns: TimeWeightedReturn = {
    return: series[30]!.return, from: dateOf(0), to: dateOf(30), netFlows: 0, series,
    risk: { stretches: 30, days: 30, volatility: 0.083, up: 20, down: 10, best: { date: "2026-01-02", return: 0.004 }, worst: { date: "2026-01-04", return: -0.0059 } },
  };
  const benchmark: BenchmarkReturn = { ticker: "VUSAl_EQ", shortName: "VUSA", source: "sample", return: 0.02, series, risk: { volatility: 0.12, beta: 0.61, correlation: 0.84 } };

  it("gives the volatility, beta, best and worst days, and the daily moves", () => {
    const html = renderToStaticMarkup(createElement(RiskPanel, { returns, benchmark, locale: "en", t: createTranslator("en") }));
    expect(html).toContain("<span>Volatility a year</span><strong>8.3%</strong><small>VUSA: 12.0%</small>");
    expect(html).toContain("<span>Beta to VUSA</span><strong>0.61</strong><small>Correlation 0.84</small>");
    expect(html).toContain('<span>Worst day</span><strong class="negative">-0.59%</strong><small>Jan 4</small>');
    expect(html).toContain("<strong>20 of 30</strong><small>67% of the days it moved</small>");
    // Under 90 days: no return over volatility.
    expect(html).not.toContain("Return ÷ volatility");
    // Each bar says its range and count.
    expect(html).toMatch(/class="moveColumn up" title="\+0\.25% to \+0\.50%: 20 days"/);
    expect(html).toContain("most often");
  });

  it("leaves the benchmark out without one, in Chinese", () => {
    const html = renderToStaticMarkup(createElement(RiskPanel, { returns, locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(html).toContain("年化波动率");
    expect(html).not.toContain("Beta");
    expect(html).toContain("每日涨跌分布");
    // Chinese sentences run on without a space.
    expect(renderToStaticMarkup(createElement(RiskPanel, { returns, benchmark, locale: "zh-CN", t: createTranslator("zh-CN") }))).toContain("不计入天数和图表。Beta 表示 VUSA");
  });
});
