import { describe, expect, it } from "vitest";
import type { ReturnPoint } from "./history";
import { benchmarkRiskOf, dailyMoves, riskOf } from "./risk";

const DAY_MS = 86_400_000;
const dateOf = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY_MS).toISOString().slice(0, 10);

/** A series from log moves, one reading every `step` days from 1 January 2026. */
function seriesOf(logs: number[], step = 1): ReturnPoint[] {
  let total = 0;
  return [{ date: dateOf(0), return: 0 }, ...logs.map((log, index) => {
    total += log;
    return { date: dateOf((index + 1) * step), return: Math.exp(total) - 1 };
  })];
}

const alternate = (size: number, count = 20) => Array.from({ length: count }, (_, index) => (index % 2 ? -size : size));

describe("risk", () => {
  it("reads the volatility a year from the daily moves", () => {
    const risk = riskOf(seriesOf(alternate(0.01)))!;
    // Twenty moves of ±1% (in logs), averaging nothing: a sample variance of 20/19 × 0.01² a day.
    expect(risk.volatility).toBeCloseTo(0.01 * Math.sqrt((20 / 19) * 365), 5);
    expect(risk).toMatchObject({ stretches: 20, days: 20, up: 10, down: 10 });
    expect(risk.best).toEqual({ date: "2026-01-02", return: 0.01005 });
    expect(risk.worst).toEqual({ date: "2026-01-03", return: -0.00995 });
    // Under 90 days: no return a year.
    expect(risk.annualized).toBeUndefined();
    expect(risk.ratio).toBeUndefined();
  });

  it("counts a stretch of several days as that many days, and only one-day stretches as days", () => {
    // Readings two days apart moving ±1.41% (in logs): the same variance a day as ±1% each day.
    const apart = riskOf(seriesOf(alternate(0.01 * Math.SQRT2), 2))!;
    expect(apart.volatility).toBeCloseTo(riskOf(seriesOf(alternate(0.01)))!.volatility, 5);
    expect(apart).toMatchObject({ stretches: 20, days: 40, up: 0, down: 0 });
    expect(apart.best).toBeUndefined();
  });

  it("leaves days that did not move out of the counts and the chart", () => {
    // A week of five moves and a still weekend, four times over.
    const logs = Array.from({ length: 28 }, (_, index) => (index % 7 >= 5 ? 0 : index % 7 === 2 ? -0.02 : 0.005));
    const risk = riskOf(seriesOf(logs))!;
    expect(risk).toMatchObject({ stretches: 28, up: 16, down: 4 });
    expect(dailyMoves(seriesOf(logs))).toHaveLength(20);
    expect(risk.worst?.return).toBeCloseTo(Math.exp(-0.02) - 1, 6);
  });

  it("gives a return a year, and it over the volatility, from 90 days", () => {
    const logs = Array.from({ length: 100 }, (_, index) => (index % 2 ? -0.004 : 0.006));
    const risk = riskOf(seriesOf(logs))!;
    expect(risk.annualized).toBeCloseTo(Math.exp((0.1 / 100) * 365) - 1, 5);
    expect(risk.ratio).toBeCloseTo(risk.annualized! / risk.volatility, 2);
  });

  it("needs 20 stretches", () => {
    expect(riskOf(seriesOf(alternate(0.01, 19)))).toBeUndefined();
  });
});

describe("benchmark risk", () => {
  const ours = seriesOf(alternate(0.01));

  it("gives the benchmark's volatility, and the return's beta and correlation to it", () => {
    // The benchmark moves twice as far, the same way: half its moves, always with it.
    expect(benchmarkRiskOf(ours, seriesOf(alternate(0.02)))).toEqual({ volatility: expect.closeTo(0.02 * Math.sqrt((20 / 19) * 365), 5), beta: 0.5, correlation: 1 });
    // The other way: against it.
    expect(benchmarkRiskOf(ours, seriesOf(alternate(-0.01)))).toMatchObject({ beta: -1, correlation: -1 });
  });

  it("gives nothing against a benchmark that never moved, or over too few stretches", () => {
    expect(benchmarkRiskOf(ours, seriesOf(alternate(0)))).toBeUndefined();
    expect(benchmarkRiskOf(seriesOf(alternate(0.01, 19)), seriesOf(alternate(0.01, 19)))).toBeUndefined();
  });
});
