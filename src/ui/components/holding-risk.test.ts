import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AllocationAnalysis, HoldingRisk } from "../../shared/history";
import { createTranslator } from "../i18n";
import { correlationText, correlationTint, HoldingRiskPanel } from "./holding-risk";

const holdings = ["AAPL_US_EQ", "MSFT_US_EQ", "KO_US_EQ"].map((ticker, index) => ({ ticker, name: ticker, currency: "USD", value: 1000 * (3 - index), weight: (3 - index) / 6 }));
const risk: HoldingRisk = {
  from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.164, diversification: 1.38, covered: 0.9,
  rows: [
    { ticker: "AAPL_US_EQ", weight: 0.5, volatility: 0.24, risk: 0.62, correlation: 0.91 },
    { ticker: "MSFT_US_EQ", weight: 0.33, volatility: 0.2, risk: 0.31, correlation: 0.8 },
    { ticker: "KO_US_EQ", weight: 0.17, volatility: 0.12, risk: 0.07, correlation: 0.31 },
  ],
  correlations: { tickers: ["AAPL_US_EQ", "MSFT_US_EQ", "KO_US_EQ"], matrix: [[1, 0.58, -0.15], [0.58, 1, 0.2], [-0.15, 0.2, 1]] },
  short: ["NEW_US_EQ"],
};
const data: Pick<AllocationAnalysis, "risk" | "riskMissing" | "holdings"> = { holdings, risk, riskMissing: [{ ticker: "ODD_US_EQ", reason: "symbol", problem: "No symbol." }] };
const render = (props: Partial<Parameters<typeof HoldingRiskPanel>[0]>, locale: "en" | "zh-CN" = "en") =>
  renderToStaticMarkup(createElement(HoldingRiskPanel, { data, locale, t: createTranslator(locale), ...props }));

describe("correlation cells", () => {
  it("writes a correlation as it fits a small cell", () => {
    expect(correlationText(0.62, "en")).toBe(".62");
    expect(correlationText(-0.15, "en")).toBe("−.15");
    expect(correlationText(0.999, "en")).toBe("1");
    expect(correlationText(-0.996, "en")).toBe("−1");
    expect(correlationText(-0.004, "en")).toBe(".00");
    // Every cell has two decimals, so the grid lines up.
    expect(correlationText(0.6, "en")).toBe(".60");
  });

  it("tints amber for together and blue for apart, by how strongly", () => {
    expect(correlationTint(0.62)).toEqual({ className: "together", style: { "--corr": "0.62" } });
    expect(correlationTint(-0.154)).toEqual({ className: "apart", style: { "--corr": "0.15" } });
    expect(correlationTint(0)).toEqual({ className: "together", style: { "--corr": "0" } });
    expect(correlationTint(1.2).style["--corr"]).toBe("1");
  });
});

describe("risk by holding panel", () => {
  it("gives the volatility together, the diversification and the largest share, with a bar pair per holding", () => {
    const html = render({});
    expect(html).toContain("<span>Volatility together</span><strong>16.4%</strong><small>Annualised, 52 weeks to Oct 9, 2026</small>");
    expect(html).toContain("<span>Diversification</span><strong>1.38</strong>");
    expect(html).toContain("<span>Most of the risk</span><strong>AAPL · 62%</strong><small>50% of the value</small>");
    expect(html).toContain('style="width:100%"');
    // The value bar is scaled to the longest bar, the 62% share of the risk.
    expect(html).toContain(`style="width:${(0.5 / 0.62) * 100}%"`);
    expect(html).toContain('<span class="visuallyHidden">MSFT: 31% of the risk, 33% of the value; volatility 20% a year, correlation 0.80 with the holdings together.</span>');
    // The grid: row and column headers, the diagonal left blank, a cell below 0 in blue.
    expect(html).toContain('<th scope="col" title="AAPL">AAPL</th>');
    expect(html).toContain('<td class="corrSelf" title="AAPL and AAPL: 1.00">·</td>');
    expect(html).toContain('<td title="AAPL and KO: -0.15" class="apart" style="--corr:0.15">−.15</td>');
    expect(html).toContain('<td title="MSFT and KO: 0.20" class="together" style="--corr:0.2">.20</td>');
    expect(html).toContain("It covers 90% of the holdings&#x27; value.");
    expect(html).toContain("Not measured, without daily closes: ODD.");
    expect(html).toContain("Too few weeks of closes to measure: NEW.");
    expect(html).not.toContain("still being read");
  });

  it("names the largest holding under its ticker, and the holdings by their short names", () => {
    const book = { AAPL_US_EQ: { name: "Apple Inc.", shortName: "AAPL" }, KO_US_EQ: { name: "Coca-Cola", shortName: "KO" } };
    const html = render({ book });
    expect(html).toContain("<strong>AAPL · 62%</strong><small>Apple Inc., 50% of the value</small>");
    expect(html).toContain('<span class="barLabel" aria-hidden="true"><strong>Apple Inc.</strong><small>AAPL</small></span>');
    // The grid's headers are the short names, with the full name on hover.
    expect(html).toContain('<th scope="row" title="Coca-Cola (KO)">KO</th>');
    expect(render({ book }, "zh-CN")).toContain("<small>Apple Inc.，市值占 50%</small>");
  });

  it("leaves the grid out for two holdings, and says when closes are still being read", () => {
    const two = { ...risk, correlations: { tickers: ["AAPL_US_EQ", "MSFT_US_EQ"], matrix: [[1, 0.58], [0.58, 1]] } };
    const html = render({ data: { holdings, risk: two, riskMissing: [{ ticker: "KO_US_EQ", reason: "later", problem: "Later." }] } });
    expect(html).not.toContain("corrTable");
    expect(html).toContain("Some closes are still being read");
    // A holding left for later is not one that could not be read.
    expect(html).not.toContain("Not measured");
  });

  it("says what it needs without a measure, and shows nothing for one holding", () => {
    expect(render({ data: { holdings, riskMissing: [{ ticker: "KO_US_EQ", reason: "later", problem: "Later." }] } })).toContain("Risk by holding needs a year of weekly closes");
    expect(render({ data: { holdings: holdings.slice(0, 1), risk } })).toBe("");
    expect(render({ data: { holdings: [holdings[0]!, { ...holdings[1]!, value: 0 }], risk } })).toBe("");
  });

  it("reads in Chinese", () => {
    const html = render({}, "zh-CN");
    expect(html).toContain("持仓风险分布");
    expect(html).toContain("<span>风险占比最大</span><strong>AAPL · 62%</strong><small>市值占 50%</small>");
    expect(html).toContain("没有日收盘价、未计入：ODD。");
    // Chinese lists use the enumeration comma.
    expect(render({ data: { ...data, riskMissing: [{ ticker: "A", reason: "data", problem: "x" }, { ticker: "B", reason: "data", problem: "y" }] } }, "zh-CN")).toContain("A、B");
  });
});
