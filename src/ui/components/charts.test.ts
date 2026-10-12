import { describe, expect, it } from "vitest";
import { decimalsOf, niceTicks } from "./charts";

describe("line chart gridlines", () => {
  it("sits at round steps inside the range", () => {
    expect(niceTicks(0, 0.244)).toEqual({ ticks: [0, 0.1, 0.2], step: 0.1 });
    expect(niceTicks(13_480, 16_920)).toEqual({ ticks: [14_000, 15_000, 16_000], step: 1000 });
    expect(niceTicks(-0.031, 0.012)).toEqual({ ticks: [-0.03, -0.02, -0.01, 0, 0.01], step: 0.01 });
    expect(niceTicks(-0.036, 0.091)).toEqual({ ticks: [-0.025, 0, 0.025, 0.05, 0.075], step: 0.025 });
  });

  it("keeps at least two gridlines however the range falls", () => {
    for (const [min, max] of [[0.01, 0.96], [0.05, 1], [1, 9.99], [0.004, 0.006], [99, 101]] as const) {
      const { ticks, step } = niceTicks(min, max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(5);
      for (const tick of ticks) {
        expect(tick).toBeGreaterThanOrEqual(min - 1e-12);
        expect(tick).toBeLessThanOrEqual(max + 1e-12);
        expect(Math.abs(tick / step - Math.round(tick / step))).toBeLessThan(1e-9);
      }
    }
  });

  it("leaves a flat range to a single line", () => {
    expect(niceTicks(5, 5)).toEqual({ ticks: [5], step: 0 });
  });
});

describe("gridline decimals", () => {
  it("writes a step with the decimals it needs", () => {
    expect([10, 5, 1, 2.5, 0.5, 0.2, 0.05, 0.001].map(decimalsOf)).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
  });
});
