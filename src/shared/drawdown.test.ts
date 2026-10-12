import { describe, expect, it } from "vitest";
import { drawdownOf, drawdownSeries } from "./drawdown";

const series = (...returns: number[]) => returns.map((value, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, return: value }));

describe("drawdown", () => {
  it("finds the deepest fall from a high, the day it was made up, and where it ends", () => {
    // Up 10%, down to 1.1 × 0.8 = 0.88 (-20% from the high), back above the high, then a smaller fall.
    const result = drawdownOf(series(0, 0.1, 0.0, -0.12, 0.05, 0.1, 0.15, 0.104));
    expect(result).toEqual({ max: -0.2, peak: "2026-09-02", trough: "2026-09-04", recovered: "2026-09-06", current: -0.04, currentPeak: "2026-09-07" });
  });

  it("keeps the deeper of two falls, and one not made up yet", () => {
    // -10% from the start, made up, then -25% from a higher high that it is still below.
    expect(drawdownOf(series(0, -0.1, 0.02, 0.2, 0.05, -0.1, -0.04))).toEqual({
      max: -0.25, peak: "2026-09-04", trough: "2026-09-06", current: -0.2, currentPeak: "2026-09-04",
    });
    // A fall from the first day: the first day is the high.
    expect(drawdownOf(series(0, -0.05))).toEqual({ max: -0.05, peak: "2026-09-01", trough: "2026-09-02", current: -0.05, currentPeak: "2026-09-01" });
  });

  it("takes a day within 0.05% of the high as at it, so a fall that would read 0.0% is none", () => {
    expect(drawdownOf(series(0, 0.1, 0.099999))).toEqual({ max: 0, current: 0 });
    // Down a third, then back to a hair under the high: made up, and at the high now.
    expect(drawdownOf(series(0, 1.5, 0.5, 1.499999))).toEqual({ max: -0.4, peak: "2026-09-02", trough: "2026-09-03", recovered: "2026-09-04", current: 0 });
  });

  it("says when it never fell, and needs two days", () => {
    expect(drawdownOf(series(0, 0.01, 0.01, 0.03))).toEqual({ max: 0, current: 0 });
    expect(drawdownOf(series(0))).toBeUndefined();
    expect(drawdownOf([])).toBeUndefined();
  });

  it("gives each day's fall from the high before it", () => {
    expect(drawdownSeries(series(0, 0.1, -0.12, 0.1, 0.05)).map((point) => point.return)).toEqual([0, 0, -0.2, 0, -0.045455]);
  });
});
