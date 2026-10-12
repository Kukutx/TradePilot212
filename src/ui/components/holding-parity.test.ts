import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AllocationAnalysis } from "../../shared/history";
import { createTranslator } from "../i18n";
import { HoldingParityPanel } from "./holding-parity";

const row = (ticker: string, weight: number, parity: number | undefined, volatility = 0.25) =>
  ({ ticker, weight, volatility, risk: weight, correlation: 0.6, ...(parity === undefined ? {} : { parity }) });
const data = (rows = [row("NVDA_US_EQ", 0.5, 0.25, 0.5), row("VUSAl_EQ", 0.3, 0.4, 0.15), row("KO_US_EQ", 0.2, 0.35, 0.12)]) => ({
  accountCurrency: "EUR", totalValue: 10_000, cash: 1000, availableCash: 900,
  holdings: rows.map((item) => ({ ticker: item.ticker, name: item.ticker, currency: "USD", value: item.weight * 8000, weight: item.weight * 0.8 })),
  risk: {
    from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.21, diversification: 1.2, covered: 1, parityVolatility: 0.154,
    rows, correlations: { tickers: [], matrix: [] },
  },
} as unknown as AllocationAnalysis);
const render = (value: AllocationAnalysis, options: { locale?: "en" | "zh-CN"; onPlan?: () => void } = {}) =>
  renderToStaticMarkup(createElement(HoldingParityPanel, { data: value, locale: options.locale ?? "en", t: createTranslator(options.locale ?? "en"), ...(options.onPlan ? { onPlan: options.onPlan } : {}) }));

describe("equal-risk weights", () => {
  it("gives the risk at those weights, what moves and the holding furthest from them, then each as a dumbbell", () => {
    const html = render(data());
    expect(html).toContain("Equal-risk weights");
    expect(html).toContain("<span>Together at these weights</span><strong>15.4%</strong><small>21.0% a year at today&#x27;s weights</small>");
    // NVDA sells 25 points of the 8,000 measured: 2,000.
    expect(html).toContain("<span>To move</span><strong>€2,000</strong><small>25% of the €8,000 measured, sold and bought again</small>");
    expect(html).toContain("<span>Furthest from it</span><strong>NVDA 50% → 25%</strong>");
    // Furthest first: NVDA (25 points), KO (15), VUSA (10).
    const order = ["NVDA", "KO", "VUSA"].map((name) => html.indexOf(`<strong>${name}</strong>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("NVDA: 25% at equal risk, 50% today; volatility 50% a year");
    expect(html).toMatch(/class="parityMark now" style="left:100%"/);
    expect(html).toMatch(/class="parityMark equal" style="left:50%"/);
    expect(html).toContain("moved less than 2% a year keeps its weight");
    // Without order tools, nothing to plan.
    expect(html).not.toContain("Plan this rebalance");
  });

  it("offers to plan the move with order tools, and says when a basket cannot take every holding", () => {
    const html = render(data(), { onPlan: () => undefined });
    expect(html).toContain(">Plan this rebalance</button>");
    // The plan moves every holding here: it sells what the tile says.
    expect(html).toContain("<span>To move</span><strong>€2,000</strong>");
    expect(html).toContain("nothing is sent until you do");
    expect(html).not.toContain("A basket takes");
    const many = Array.from({ length: 22 }, (_, index) => row(`T${index}_US_EQ`, 1 / 22, 1 / 22 + (index % 2 ? 1 : -1) * 0.001));
    const crowded = render(data(many), { onPlan: () => undefined });
    expect(crowded).toContain("A basket takes 20 orders, so it moves the 20 furthest from their equal-risk weight and leaves the rest.");
    expect(crowded).toContain("10 more in the table view.");
  });

  it("is left out without equal-risk weights, and reads in Chinese", () => {
    expect(render(data([row("A", 0.6, undefined), row("B", 0.4, undefined)]))).toBe("");
    const zh = render(data(), { locale: "zh-CN", onPlan: () => undefined });
    expect(zh).toContain("风险平价权重");
    expect(zh).toContain("<span>偏离最大</span>");
    expect(zh).toContain(">生成调仓草稿</button>");
  });
});
