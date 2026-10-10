import { describe, expect, it } from "vitest";
import { analyzePortfolio, evaluateRule, stressPortfolio } from "./analytics.js";
import { samplePortfolio } from "./sample.js";

describe("currency-aware portfolio intelligence", () => {
  it("computes deterministic concentration and cash from full USD sample coverage", () => {
    const portfolio = samplePortfolio("demo");
    const result = analyzePortfolio(portfolio);
    expect(result.exposureCoveragePercent).toBe(100);
    expect(result.cashPercent).toBeCloseTo(17.86);
    expect(result.largestPositionPercent).toBeCloseTo(32.14);
    expect(result.concentrationHhi).not.toBeNull();
    expect(result.source).toBe("sample");
    expect(result.limitations.join(" ")).toContain("SYNTHETIC");
  });
  it("refuses to fabricate total concentration and stress values when FX is missing", () => {
    const portfolio = samplePortfolio("live");
    portfolio.holdings[0]!.currency = "EUR";
    portfolio.holdings[0]!.valueInAccountCurrency = null;
    portfolio.holdings[0]!.valueProvenance = "unknown";
    const insight = analyzePortfolio(portfolio);
    expect(insight.largestPositionPercent).toBeNull();
    expect(insight.concentrationHhi).toBeNull();
    const stress = stressPortfolio(portfolio, -20);
    expect(stress.hypotheticalPortfolioValue).toBeNull();
  });
  it("produces clearly hypothetical scenarios, never forecasts", () => {
    const v = stressPortfolio(samplePortfolio("demo"), -10);
    expect(v.hypotheticalPortfolioChange).toBe(-230);
    expect(v.hypotheticalPortfolioValue).toBe(2570);
    expect(v.assumptions.join(" ")).toMatch(/not a market forecast/);
    expect(() => stressPortfolio(samplePortfolio("demo"), -99)).toThrow();
  });
  it("evaluates rules deterministically", () => {
    const p = samplePortfolio("demo");
    const a = analyzePortfolio(p);
    const cash = { id: "x", kind: "cash_below" as const, thresholdPercent: 20, environment: "demo" as const, createdAt: p.asOf };
    const risk = { ...cash, kind: "largest_position_above" as const, thresholdPercent: 50 };
    expect(evaluateRule(cash, p, a).status).toBe("triggered");
    expect(evaluateRule(risk, p, a).status).toBe("clear");
  });
});
