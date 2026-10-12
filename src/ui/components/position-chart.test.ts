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
  it("draws the value beside the dashed line of the net put in, and says what the price did", () => {
    const html = renderToStaticMarkup(createElement(PositionChart, { history, currency: "EUR", quoteCurrency: "USD", locale: "en", t: createTranslator("en") }));
    expect(html).toContain("<span>Your position</span>");
    expect(html).toContain('class="lineCompare"');
    expect(html).toContain("Net put in</li>");
    expect(html).toContain('<strong class="positive">+€102.00</strong> · made by the price since Sep 1, 2026: the value against the net put in, which is the 8 shares held then');
    // A dollar holding in a euro account: the rate is said.
    expect(html).toContain("Amounts are at today&#x27;s exchange rate.");
  });

  it("shows zero when sells take the net put in below it, and says where a shortened history starts and which rates it uses", () => {
    const soldOut = { ...history, shortened: true as const, fillRates: true as const, days: [...history.days, { date: "2026-09-08", shares: 0, value: 0, base: -150 }] };
    const html = renderToStaticMarkup(createElement(PositionChart, { history: soldOut, currency: "EUR", quoteCurrency: "USD", locale: "en", t: createTranslator("en") }));
    expect(html).toMatch(/text-anchor="end">€0<\/text>/);
    expect(html).toContain("Amounts are at its fills&#x27; exchange rates, as nothing in its currency is held now. Older fills were not read, so it starts on Sep 1, 2026.");
    // In the account's own currency (or pence in a pound account), no rate is said.
    expect(renderToStaticMarkup(createElement(PositionChart, { history, currency: "GBP", quoteCurrency: "GBX", locale: "en", t: createTranslator("en") }))).not.toContain("exchange rate");
  });

  it("says it without shares at the start, in Chinese", () => {
    const html = renderToStaticMarkup(createElement(PositionChart, { history: { ...history, startShares: 0 }, currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(html).toContain("持仓走势");
    expect(html).toContain("净投入");
    expect(html).toContain("自 2026年9月1日 以来价格带来的：市值对比净投入，即买入减去卖出的金额。");
  });
});
