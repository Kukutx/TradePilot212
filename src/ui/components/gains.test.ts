import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GainAttribution, HoldingGain } from "../../shared/history";
import { createTranslator } from "../i18n";
import { GainChart } from "./gains";

const holding = (ticker: string, gain: number, extra: Partial<HoldingGain> = {}): HoldingGain => ({
  ticker, startQuantity: 10, quantity: 10, startValue: 1000, value: 1000 + gain, bought: 0, sold: 0, dividends: 0, gain, return: gain / 1000, ...extra,
});
const book = { NVDA_US_EQ: { ticker: "NVDA_US_EQ", name: "NVIDIA", shortName: "NVDA" } };
const render = (attribution: GainAttribution, locale: "en" | "zh-CN" = "en", onOpen?: (ticker: string) => void) =>
  renderToStaticMarkup(createElement(GainChart, { attribution, currency: "EUR", book, locale, t: createTranslator(locale), ...(onOpen ? { onOpen } : {}) }));

describe("gain chart", () => {
  it("draws gains right and losses left of one zero line, largest first, with the total and the start", () => {
    const html = render({
      basis: "start", from: "2026-09-12", to: "2026-10-12T10:00:00Z", total: 260,
      holdings: [holding("NVDA_US_EQ", 300, { dividends: 2.5, bought: 200 }), holding("KO_US_EQ", -40)],
      missing: [],
    }, "en", () => {});
    expect(html).toContain('<p class="gainTotal"><strong class="positive">+€260.00</strong><span>since Sep 12, 2026</span></p>');
    // The zero line where 40 of loss and 300 of gain fill the track: 40 / 340 of the way.
    expect(html).toContain('<span class="gainZero" style="left:11.8%"></span><span class="gainFill up" style="left:11.8%;width:88.2%"></span>');
    expect(html).toContain('<span class="gainFill down" style="right:88.2%;width:11.8%"></span>');
    expect(html).toContain('<button type="button" class="inlineLink reviewName" title="NVDA_US_EQ" aria-label="Open NVIDIA"');
    expect(html).toContain("<small>+30.0%</small>");
    expect(html).toContain("NVIDIA: +€300.00 (+30.0%) · start €1,000.00 · bought €200.00 · dividends €2.50 · now €1,300.00");
    expect(html).toContain("Currency moves on what was held at the start are not in it.");
    expect(html).not.toContain("Not counted");
  });

  it("names what it could not value, and over all history says so, in Chinese", () => {
    const html = render({
      basis: "cost", to: "2026-10-12T10:00:00Z", total: 120,
      holdings: [holding("NVDA_US_EQ", 120, { startQuantity: 0, startValue: 0 })],
      missing: [{ ticker: "TSLA_US_EQ", reason: "quantity", problem: "x" }],
    }, "zh-CN");
    expect(html).toContain("<span>全部历史，按买入成本计</span>");
    // Only gains: the zero line is the track's left edge and is not drawn.
    expect(html).not.toContain("gainZero");
    expect(html).toContain('<span class="gainFill up" style="left:0%;width:100%"></span>');
    expect(html).toContain("未计入：TSLA。");
    expect(html).toContain("Trading 212 记录的卖出已实现盈亏");
    expect(render({ basis: "start", from: "2026-09-12", to: "2026-10-12T10:00:00Z", total: 0, holdings: [], missing: [] })).toContain("Nothing was held or traded in this period.");
  });
});
