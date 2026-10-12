import { describe, expect, it } from "vitest";
import { axisMoney, decimalsOf, niceTicks } from "./charts";

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
    expect([10, 5, 1, 2.5, 0.5, 0.2, 0.05, 0.025, 0.001, 0.00025].map(decimalsOf)).toEqual([0, 0, 0, 1, 1, 1, 2, 3, 3, 4]);
  });
});

describe("money on the value axis", () => {
  const labels = (min: number, max: number, locale: "en" | "zh-CN") => {
    const { ticks, step } = niceTicks(min, max);
    return ticks.map((value) => axisMoney(value, step, "EUR", locale));
  };

  it("writes round values short, without trailing zeros", () => {
    expect(labels(13_480, 16_920, "en")).toEqual(["€14K", "€15K", "€16K"]);
    expect(labels(1_002_000, 1_091_000, "en")).toEqual(["€1.025M", "€1.05M", "€1.075M"]);
  });

  it("gives a short value the decimals its step needs, and writes it in full when three are not enough", () => {
    expect(labels(5_000, 5_090, "en")).toEqual(["€5K", "€5.025K", "€5.05K", "€5.075K"]);
    expect(labels(14_000, 14_900, "zh-CN")).toEqual(["€1.4万", "€1.425万", "€1.45万", "€1.475万"]);
    expect(labels(10_000, 10_000.01, "en")).toEqual(["€10,000", "€10,000.005", "€10,000.01"]);
  });
});
