import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { PositionChart } from "./position-chart";

const history = {
  startShares: 8,
  gain: 102,
  days: [
    { date: "2026-09-01", shares: 8, value: 400, base: 400 },
    { date: "2026-09-02", shares: 12, value: 660, base: 616 },
    { date: "2026-09-04", shares: 10, value: 600, base: 498 },
  ],
};

describe("position chart", () => {
  it("draws the value beside the dashed line had the price not moved, and says what the price did", () => {
    const html = renderToStaticMarkup(createElement(PositionChart, { history, currency: "EUR", locale: "en", t: createTranslator("en") }));
    expect(html).toContain("<span>Your position</span>");
    expect(html).toContain('class="lineCompare"');
    expect(html).toContain("Had the price not moved</li>");
    expect(html).toContain('<strong class="positive">+€102.00</strong> · from the price since Sep 1, 2026: the value against the 8 shares held then');
  });

  it("says it without shares at the start, in Chinese", () => {
    const html = renderToStaticMarkup(createElement(PositionChart, { history: { ...history, startShares: 0 }, currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(html).toContain("持仓走势");
    expect(html).toContain("若价格不变");
    expect(html).toContain("市值对比买入减去卖出的金额");
  });
});
