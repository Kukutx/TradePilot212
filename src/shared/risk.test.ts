import { describe, expect, it } from "vitest";
import type { ReturnPoint } from "./history";
import { benchmarkRiskOf, dailyMoves, riskOf } from "./risk";

const DAY_MS = 86_400_000;
/** Calendar days from Monday 5 January 2026. */
const dayOf = (day: number) => new Date(Date.UTC(2026, 0, 5) + day * DAY_MS).toISOString().slice(0, 10);
/** The nth weekday from Monday 5 January 2026. */
const weekdayOf = (index: number) => dayOf(Math.floor(index / 5) * 7 + (index % 5));

/** A series from log moves, one reading every `step` weekdays from Monday 5 January 2026. */
function seriesOf(logs: number[], step = 1): ReturnPoint[] {
  let total = 0;
  return [{ date: weekdayOf(0), return: 0 }, ...logs.map((log, index) => {
    total += log;
    return { date: weekdayOf((index + 1) * step), return: Math.exp(total) - 1 };
  })];
}

const alternate = (size: number, count = 20) => Array.from({ length: count }, (_, index) => (index % 2 ? -size : size));

/** Seeded normal draws (mulberry32 and Box–Muller), the same on every run. */
function normals(count: number, seed = 7): number[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: count }, () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()));
}

describe("risk", () => {
  it("reads the volatility a year from the daily moves, over weekdays", () => {
    const risk = riskOf(seriesOf(alternate(0.01)))!;
    // Twenty moves of ±1% (in logs), averaging nothing: a sample variance of 20/19 × 0.01² a weekday.
    expect(risk.volatility).toBeCloseTo(0.01 * Math.sqrt((20 / 19) * 261), 5);
    expect(risk).toMatchObject({ from: "2026-01-05", to: "2026-02-02", stretches: 20, days: 20, up: 10, down: 10 });
    expect(risk.best).toEqual({ date: "2026-01-06", return: 0.01005 });
    expect(risk.worst).toEqual({ date: "2026-01-07", return: -0.00995 });
    // Under a year: no return a year.
    expect(risk.annualized).toBeUndefined();
    expect(risk.ratio).toBeUndefined();
  });

  it("joins a reading at the weekend to the Monday's stretch", () => {
    // Readings every calendar day for six weeks; the weekends earn a little interest, which shows on the Monday.
    const series: ReturnPoint[] = [{ date: dayOf(0), return: 0 }];
    let total = 0;
    for (let day = 1; day <= 42; day++) {
      const weekend = day % 7 >= 5;
      total += weekend ? 0.00002 : day % 2 ? 0.01 : -0.01;
      series.push({ date: dayOf(day), return: Math.exp(total) - 1 });
    }
    const risk = riskOf(series)!;
    expect(risk).toMatchObject({ stretches: 30, days: 30 });
    expect(risk.up + risk.down).toBe(30);
    // Every day of the chart is a weekday.
    expect(dailyMoves(series).every((move) => ![0, 6].includes(new Date(move.date).getUTCDay()))).toBe(true);
  });

  it("dates a move read at the weekend after a missed Friday on the Friday", () => {
    const series = seriesOf(alternate(0.01, 24));
    // No reading on Friday 16 January; one on Saturday 17 January, 5% up from Thursday.
    const friday = series.findIndex((point) => point.date === "2026-01-16");
    series[friday] = { date: "2026-01-17", return: (1 + series[friday - 1]!.return) * 1.05 - 1 };
    const risk = riskOf(series)!;
    expect(risk.best).toEqual({ date: "2026-01-16", return: 0.05 });
    expect(dailyMoves(series).every((move) => ![0, 6].includes(new Date(move.date).getUTCDay()))).toBe(true);
  });

  it("counts a stretch of several weekdays as that many, and only one-weekday stretches as days", () => {
    // Readings two weekdays apart moving ±1.41% (in logs): the same variance a day as ±1% each day.
    const apart = riskOf(seriesOf(alternate(0.01 * Math.SQRT2), 2))!;
    expect(apart.volatility).toBeCloseTo(riskOf(seriesOf(alternate(0.01)))!.volatility, 5);
    expect(apart).toMatchObject({ stretches: 20, days: 40, up: 0, down: 0 });
    expect(apart.best).toBeUndefined();
  });

  it("leaves weekdays that did not move out of the counts and the chart", () => {
    // Four weeks of four moves and a holiday.
    const logs = Array.from({ length: 20 }, (_, index) => (index % 5 === 4 ? 0 : index % 5 === 2 ? -0.02 : 0.005));
    const risk = riskOf(seriesOf(logs))!;
    expect(risk).toMatchObject({ stretches: 20, up: 12, down: 4 });
    expect(dailyMoves(seriesOf(logs))).toHaveLength(16);
    expect(risk.worst?.return).toBeCloseTo(Math.exp(-0.02) - 1, 6);
  });

  it("leaves out a stretch that ends today, which is not over", () => {
    const series = seriesOf(alternate(0.01, 21));
    const today = series[series.length - 1]!.date;
    expect(riskOf(series, today)).toMatchObject({ stretches: 20, to: series[series.length - 2]!.date });
    expect(riskOf(series)).toMatchObject({ stretches: 21, to: today });
    expect(riskOf(seriesOf(alternate(0.01)), weekdayOf(20))).toBeUndefined();
  });

  it("gives a return a year, and it over the volatility, from a year", () => {
    const year = (count: number) => Array.from({ length: count }, (_, index) => (index % 2 ? -0.004 : 0.006));
    // 260 weekdays on from a Monday is a Monday 364 days on: short of a year.
    expect(riskOf(seriesOf(year(260)))!.annualized).toBeUndefined();
    const risk = riskOf(seriesOf(year(262)))!;
    // 262 weekdays on is a Wednesday 366 days on, and the logs add up to 0.262.
    expect(risk.annualized).toBeCloseTo(Math.exp(0.262 * (365 / 366)) - 1, 5);
    expect(risk.ratio).toBeCloseTo(risk.annualized! / risk.volatility, 2);
    // An account as good as cash rises every day by about the same: no ratio from a volatility that small.
    const cash = riskOf(seriesOf(Array.from({ length: 262 }, (_, index) => 0.00015 + (index % 2 ? 1e-6 : -1e-6))))!;
    expect(cash.annualized).toBeGreaterThan(0.03);
    expect(cash.ratio).toBeUndefined();
  });

  it("needs 20 stretches", () => {
    expect(riskOf(seriesOf(alternate(0.01, 19)))).toBeUndefined();
  });
});

describe("benchmark risk", () => {
  const draws = normals(1000).map((value) => 0.01 * value);
  const benchmark = seriesOf(draws);

  it("gives the benchmark's volatility, and the return's beta and correlation to it", () => {
    const same = benchmarkRiskOf(benchmark, benchmark)!;
    expect(same).toEqual({ volatility: riskOf(benchmark)!.volatility, beta: 1, correlation: 1 });
    // Twice as far the same way, and the other way.
    expect(benchmarkRiskOf(seriesOf(draws.map((value) => 2 * value)), benchmark)).toMatchObject({ beta: 2, correlation: 1 });
    expect(benchmarkRiskOf(seriesOf(draws.map((value) => -value)), benchmark)).toMatchObject({ beta: -1, correlation: -1 });
    // With moves of its own beside the benchmark's: close to the 1.1 and 0.96 they were drawn with.
    const own = normals(1000, 3).map((value) => 0.003 * value);
    const mixed = benchmarkRiskOf(seriesOf(draws.map((value, index) => 1.1 * value + own[index]!)), benchmark)!;
    expect(Math.abs(mixed.beta! - 1.1)).toBeLessThan(0.05);
    expect(Math.abs(mixed.correlation! - 0.96)).toBeLessThan(0.03);
  });

  it("lines up readings taken before the benchmark's close", () => {
    // Each day's reading comes a quarter of the way through the benchmark's day: it holds the last three quarters of
    // the day before and the first quarter of its own.
    const halves = normals(2000, 11).map((value) => 0.01 * value);
    const early = Array.from({ length: 1000 }, (_, index) => halves[2 * index]! * 0.5);
    const late = Array.from({ length: 1000 }, (_, index) => halves[2 * index + 1]! * Math.sqrt(0.75));
    const theirs = seriesOf(early.map((value, index) => value + late[index]!));
    const ours = seriesOf(early.map((value, index) => value + (index ? late[index - 1]! : 0)));
    const risk = benchmarkRiskOf(ours, theirs)!;
    expect(risk.beta).toBeGreaterThan(0.9);
    expect(risk.beta).toBeLessThan(1.1);
    expect(risk.correlation).toBeGreaterThan(0.9);
  });

  it("gives nothing against a benchmark that never moved, or over too few stretches", () => {
    const ours = seriesOf(alternate(0.01));
    expect(benchmarkRiskOf(ours, seriesOf(alternate(0)))).toBeUndefined();
    expect(benchmarkRiskOf(seriesOf(alternate(0.01, 19)), seriesOf(alternate(0.01, 19)))).toBeUndefined();
  });

  it("gives only the benchmark's volatility under 60 stretches, or against a benchmark as good as cash", () => {
    const short = seriesOf(draws.slice(0, 59));
    expect(benchmarkRiskOf(short, short)).toEqual({ volatility: riskOf(short)!.volatility });
    expect(benchmarkRiskOf(seriesOf(draws.slice(0, 60)), seriesOf(draws.slice(0, 60)))).toMatchObject({ beta: 1, correlation: 1 });
    // A money-market fund accruing 3.5% a year, to the cent: an unrelated account would read a beta in the hundreds.
    let price = 100;
    const fund = [{ date: weekdayOf(0), return: 0 }, ...Array.from({ length: 100 }, (_, index) => {
      price = Math.round(price * (1 + 0.035 / 261) * 100) / 100;
      return { date: weekdayOf(index + 1), return: price / 100 - 1 };
    })];
    const risk = benchmarkRiskOf(seriesOf(normals(100, 5).map((value) => 0.01 * value)), fund)!;
    expect(risk.volatility).toBeLessThan(0.005);
    expect(risk.beta).toBeUndefined();
  });

  it("reads only the stretches up to the return's last day", () => {
    const through = weekdayOf(80);
    expect(benchmarkRiskOf(benchmark, benchmark, through)!.volatility).toBeCloseTo(riskOf(benchmark.slice(0, 81))!.volatility, 6);
  });
});
