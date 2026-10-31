import { describe, expect, it } from "vitest";
import { goalPace, monthsUntil, normalCdf, projectGoal, realReturn } from "./goal.js";

const now = new Date("2026-10-31T12:00:00Z");

describe("goal projection", () => {
  it("counts months to the date, a part month as one", () => {
    expect(monthsUntil("2026-11-30", now)).toBe(1);
    expect(monthsUntil("2036-10-31", now)).toBe(120);
    expect(monthsUntil("2036-11-01", now)).toBe(121);
    expect(monthsUntil("2025-01-01", now)).toBe(0);
    expect(monthsUntil("not a date", now)).toBe(0);
  });

  it("matches the normal distribution", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.2815515655446004)).toBeCloseTo(0.9, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("grows a lump sum and contributions, with a range that widens and a middle line at the median", () => {
    const projection = projectGoal({ target: 100_000, by: "2036-10-31", monthly: 300, expectedReturn: 0.06, volatility: 0.15 }, 20_000, now);
    expect(projection.months).toBe(120);
    expect(projection.points[0]).toMatchObject({ date: "2026-10-31", low: 20_000, mid: 20_000, high: 20_000, added: 20_000 });
    expect(projection.points.at(-1)).toMatchObject({ date: "2036-10-31", added: 56_000 });
    expect(projection.points).toHaveLength(121);
    const { low, mid, high } = projection.final;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    // Median growth ln(1.06) - 0.15²/2 ≈ 4.7% a year: 20,000 grows to about 32,000, 300 a month to about 46,000.
    expect(mid).toBeGreaterThan(75_000);
    expect(mid).toBeLessThan(82_000);
    expect(projection.added).toBe(36_000);
    expect(projection.chance).toBeGreaterThan(0.2);
    expect(projection.chance).toBeLessThan(0.5);
    // Enough each month to reach it on the middle line.
    const needed = projectGoal({ target: 100_000, by: "2036-10-31", monthly: projection.neededMonthly, expectedReturn: 0.06, volatility: 0.15 }, 20_000, now);
    expect(needed.final.mid).toBeCloseTo(100_000, 0);
    expect(needed.chance).toBeCloseTo(0.5, 2);
  });

  it("says when the goal is reached already, out of reach, or past", () => {
    expect(projectGoal({ target: 10_000, by: "2030-01-01", monthly: 0, expectedReturn: 0.06, volatility: 0.15 }, 12_000, now)).toMatchObject({ reached: true, chance: 1, neededMonthly: 0 });
    expect(projectGoal({ target: 10_000_000, by: "2027-10-31", monthly: 100, expectedReturn: 0.06, volatility: 0.15 }, 1_000, now).chance).toBeLessThan(0.0001);
    expect(projectGoal({ target: 50_000, by: "2020-01-01", monthly: 100, expectedReturn: 0.06, volatility: 0.15 }, 1_000, now)).toMatchObject({ months: 0, chance: 0, points: [{ mid: 1_000 }] });
    // No volatility: the range closes on the middle line.
    const flat = projectGoal({ target: 20_000, by: "2031-10-31", monthly: 0, expectedReturn: 0.05, volatility: 0 }, 10_000, now);
    expect(flat.final.low).toBeCloseTo(flat.final.mid, 6);
    expect(flat.chance).toBe(0);
  });

  it("steps a quarter at a time beyond ten years", () => {
    const projection = projectGoal({ target: 1_000_000, by: "2056-10-31", monthly: 500, expectedReturn: 0.07, volatility: 0.18 }, 50_000, now);
    expect(projection.months).toBe(360);
    expect(projection.points).toHaveLength(121);
  });

  it("grows at the return after inflation, so the projection is in today's money", () => {
    expect(realReturn({ expectedReturn: 0.06, inflation: 0.02 })).toBeCloseTo(0.0392, 4);
    expect(realReturn({ expectedReturn: 0.06 })).toBe(0.06);
    const base = { target: 100_000, by: "2036-10-31", monthly: 200, expectedReturn: 0.06, volatility: 0.15 };
    const nominal = projectGoal(base, 20_000, now);
    const real = projectGoal({ ...base, inflation: 0.02 }, 20_000, now);
    expect(real.final.mid).toBeLessThan(nominal.final.mid);
    expect(real.chance).toBeLessThan(nominal.chance);
  });

  it("measures the pace from the goal's start once a whole month has passed", () => {
    const goal = { target: 100_000, by: "2036-10-31", monthly: 500, expectedReturn: 0, volatility: 0, start: { value: 10_000, at: "2026-08-15T09:00:00Z" } };
    // At no growth, two whole months of 500 since mid-August.
    expect(goalPace(goal, 11_500, now)).toEqual({ since: "2026-08-15T09:00:00Z", months: 2, expected: 11_000, difference: 500 });
    expect(goalPace({ ...goal, start: { value: 10_000, at: "2026-10-20T00:00:00Z" } }, 11_500, now)).toBeUndefined();
    expect(goalPace({ ...goal, start: undefined }, 11_500, now)).toBeUndefined();
    expect(projectGoal(goal, 10_500, now).pace?.difference).toBe(-500);
  });

  it("finds the chance of a short goal that needs growth far beyond ±300% a year", () => {
    // 30% in a month is likely enough at 100% volatility.
    const up = projectGoal({ target: 130, by: "2026-11-30", monthly: 0, expectedReturn: 0.3, volatility: 1 }, 100, now);
    expect(up.chance).toBeCloseTo(0.164, 2);
    expect(up.final.high).toBeGreaterThan(130);
    // What is added reaches it whatever the growth: certain.
    expect(projectGoal({ target: 500, by: "2026-11-30", monthly: 1_000, expectedReturn: 0, volatility: 1 }, 0, now).chance).toBe(1);
    const halfway = projectGoal({ target: 150, by: "2026-11-30", monthly: 0, expectedReturn: 0, volatility: 1 }, 100, now);
    expect(halfway.chance).toBeGreaterThan(0.05);
    expect(halfway.chance).toBeLessThan(0.2);
  });
});
