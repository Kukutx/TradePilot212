import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PriceHistory, PricePoint } from "../../shared/prices";
import { createTranslator } from "../i18n";
import { chartTrades } from "../views/HoldingView";
import { PriceChart, priceDigits, priceRanges, spreadTags, tagRoom, type ChartLevel } from "./price-chart";

/** Weekday closes from `start` for `days` calendar days, rising by one a day from 100. */
function closes(start: string, days: number): PricePoint[] {
  const points: PricePoint[] = [];
  for (let day = 0; day < days; day++) {
    const date = new Date(Date.parse(`${start}T00:00:00Z`) + day * 86_400_000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) points.push({ date: date.toISOString().slice(0, 10), close: 100 + day });
  }
  return points;
}

const t = createTranslator("en");
const year: PriceHistory = { source: "stooq", symbol: "AAPL.US", points: closes("2025-10-13", 365) };

describe("price chart ranges and tags", () => {
  it("offers only the ranges the closes cover in full, and all of them when they go back further", () => {
    expect(priceRanges(year.points)).toEqual(["1m", "3m", "6m", "1y"]);
    // Alpha Vantage's free plan: about 145 days, so no "6 months" that is really five.
    expect(priceRanges(closes("2026-05-20", 145))).toEqual(["1m", "3m", "all"]);
    // A listing 20 days old.
    expect(priceRanges(closes("2026-09-20", 20))).toEqual(["all"]);
    expect(priceRanges([])).toEqual([]);
  });

  it("writes small prices with the digits that tell them apart", () => {
    expect(priceDigits(231.55)).toBe(2);
    expect(priceDigits(0.5)).toBe(4);
    expect(priceDigits(0.0132)).toBe(5);
    expect(priceDigits(0)).toBe(2);
  });

  it("pushes overlapping tags apart and keeps them inside the plot, in their own order", () => {
    expect(spreadTags([50, 52, 120], 10, 200, 20)).toEqual([50, 70, 120]);
    expect(spreadTags([195, 60, 199], 10, 200, 20)).toEqual([180, 60, 200]);
    expect(spreadTags([2], 10, 200, 20)).toEqual([10]);
    expect(tagRoom(10, 200, 20)).toBe(10);
  });
});

describe("price chart", () => {
  const levels: ChartLevel[] = [
    { key: "average", kind: "average", price: 300, label: "Average cost" },
    { key: "order-1", kind: "stop", price: 380, label: "Sell Stop · 5" },
    { key: "alert-1", kind: "alert", price: 2000, label: "Alert: Above" },
  ];
  const trades = chartTrades([
    { orderId: "1", filledAt: "2026-03-02T14:00:00Z", side: "BUY", quantity: 3, price: 240, priceCurrency: "USD" },
    { orderId: "2", filledAt: "2026-06-01T15:00:00Z", side: "SELL", quantity: -2, price: 330, priceCurrency: "USD" },
    // Before the closes: left off the chart.
    { orderId: "3", filledAt: "2025-01-02T15:00:00Z", side: "BUY", quantity: 1, price: 90, priceCurrency: "USD" },
    { orderId: "4", side: "BUY", quantity: 1 },
  ], "USD", t, "en");
  const render = (data = year, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(PriceChart, {
    prices: data, trades, levels, currency: "USD", locale, t: createTranslator(locale),
  }));

  it("marks each trade by shape as well as colour, draws the levels near the prices and tags the one off the scale at its edge", () => {
    expect(trades.map((trade) => [trade.side, trade.text])).toEqual([["buy", "Bought 3 at $240.00"], ["sell", "Sold 2 at $330.00"], ["buy", "Bought 1 at $90.00"]]);
    const html = render();
    expect(html.match(/class="tradeMark buy"/g)).toHaveLength(1);
    expect(html.match(/class="tradeMark sell"/g)).toHaveLength(1);
    expect(html).toContain('class="priceLevel average"');
    expect(html).toContain('class="priceLevel stop"');
    expect(html).not.toContain('<line class="priceLevel alert" x1="6"');
    expect(html).toContain('<g class="priceTag alert edge"><title>Alert: Above $2,000.00</title><rect');
    expect(html).toContain(">↑2,000<");
    expect(html).not.toContain("Too far");
    // The last close and each level have a tag on the axis.
    expect(html.match(/class="priceTag /g)).toHaveLength(4);
    expect(html).toContain(">464<");
    // The year's change and range, in words.
    expect(html).toContain('<strong class="positive">+364.0%</strong><span>12 months</span>');
    expect(html).toContain("High $464.00 · Low $100.00");
    expect(html).toContain('aria-label="Daily closes, 12 months: $100.00 to $464.00 (+364.0%). Trades marked: buys 1, sells 1."');
    expect(html).toContain("Daily closes from Stooq (AAPL.US)");
    // The legend names what is drawn or tagged, and only that.
    expect(html).toContain("Stop order");
    expect(html).toContain("Price alert<");
    expect(html).not.toContain("Limit order");
  });

  it("keeps a short range's scale to its prices, with a level far below them tagged at the bottom edge", () => {
    const month: PriceHistory = { source: "stooq", symbol: "AAPL.US", points: closes("2026-09-14", 25) };
    const html = renderToStaticMarkup(createElement(PriceChart, {
      prices: month, trades: [], currency: "USD", locale: "en", t,
      levels: [{ key: "average", kind: "average", price: 50, label: "Average cost" }, { key: "order-1", kind: "stop", price: 95, label: "Sell Stop · 5" }],
    }));
    expect(html).toContain('class="priceLevel stop"');
    expect(html).not.toContain('<line class="priceLevel average" x1="6"');
    expect(html).toContain('<g class="priceTag average edge"><title>Average cost $50.00</title><rect');
    expect(html).toContain(">↓50<");
    // The axis runs from the stop to the closes, not down to the average cost.
    const axis = [...html.matchAll(/class="lineAxis" x="[\d.]+" y="[\d.]+" dy="0.32em">([\d.]+)</g)].map((match) => Number(match[1]));
    expect(Math.min(...axis)).toBeGreaterThanOrEqual(90);
  });

  it("tags only as many levels as fit, nearest the last close first, and names a trade far from the closes", () => {
    const many: ChartLevel[] = Array.from({ length: 14 }, (_, index) => ({ key: `alert-${index}`, kind: "alert", price: 330 + index * 10, label: `Alert ${index}` }));
    const far = chartTrades([{ orderId: "5", filledAt: "2026-03-02T14:00:00Z", side: "BUY", quantity: 1, price: 4000, priceCurrency: "USD" }], "USD", t, "en");
    const html = renderToStaticMarkup(createElement(PriceChart, { prices: year, trades: far, levels: many, currency: "USD", locale: "en", t }));
    expect(html.match(/class="priceLevel alert"/g)?.length).toBeGreaterThanOrEqual(14);
    const tags = [...html.matchAll(/<g class="priceTag [a-z]+"><line[^>]*\/><rect x="[\d.]+" y="(-?[\d.]+)"/g)].map((match) => Number(match[1]));
    expect(tags.length).toBeLessThan(15);
    expect(Math.min(...tags)).toBeGreaterThanOrEqual(14);
    expect(html).not.toContain("tradeMark");
    expect(html).toContain("Too far from these prices to draw: Bought 1 at $4,000.00 (Mar 2, 2026).");
  });

  it("says so for sample prices, and in Chinese", () => {
    const html = render({ ...year, source: "sample" }, "zh-CN");
    expect(html).toContain("样例账户的模拟价格");
    expect(html).toContain("近 12 个月");
    expect(html).toContain('aria-label="近 6 个月"');
  });
});
