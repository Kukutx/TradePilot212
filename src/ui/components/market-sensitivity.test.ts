import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MarketSensitivity } from "../../shared/history";
import { createTranslator } from "../i18n";
import { betaScale, MarketSensitivityPanel } from "./market-sensitivity";

const market: MarketSensitivity = {
  ticker: "SPY_US_EQ", from: "2025-10-31", to: "2026-10-23", weeks: 51, volatility: 0.18, beta: 1.2, correlation: 0.9,
  rows: [{ ticker: "NVDA_US_EQ", weight: 0.4, beta: 1.8, correlation: 0.8 }, { ticker: "KO_US_EQ", weight: 0.6, beta: 0.8, correlation: 0.6 }],
  worstWeek: { date: "2026-04-03", market: -0.065, mix: -0.08 },
};
const data = { accountCurrency: "EUR", totalValue: 12_500, risk: { mix: { value: 10_000 } as never } };
const book = { NVDA_US_EQ: { name: "NVIDIA", shortName: "NVDA" } };

describe("the market panel", () => {
  it("gives the beta together, the market's worst week and what each fall would take", () => {
    const html = renderToStaticMarkup(createElement(MarketSensitivityPanel, { market, data, book, locale: "en", t: createTranslator("en") }));
    expect(html).toContain("Beta to SPY");
    expect(html).toContain(">1.20<");
    expect(html).toContain("about 1.2× as much");
    expect(html).toContain("-6.5%");
    expect(html).toContain("today&#x27;s mix -8.0% that week");
    // −10% in the market: −12% of the holdings, €1,200, 9.6% of the account.
    expect(html).toContain("SPY -10%");
    expect(html).toContain("-12.0%");
    expect(html).toContain("About -€1,200");
    expect(html).toContain("-9.6% of the account");
    // The highest beta first, as a bar from 0 with the mark at 1.
    expect(html.indexOf("NVIDIA")).toBeLessThan(html.indexOf("KO"));
    expect(html).toContain('class="betaOne" style="left:50%"');
  });

  it("draws a negative beta below 0, and says so in Chinese", () => {
    const against = { ...market, beta: -0.3, rows: [{ ticker: "GLD_US_EQ", weight: 1, beta: -0.3, correlation: -0.2 }] };
    const html = renderToStaticMarkup(createElement(MarketSensitivityPanel, { market: against, data, locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(html).toContain("平均与它反向波动");
    expect(html).toContain("betaFill against");
    expect(html).toContain('class="betaZero"');
    expect(betaScale(against.rows)).toEqual({ low: -0.5, high: 1.5 });
    expect(betaScale(market.rows)).toEqual({ low: 0, high: 2 });
  });
});
