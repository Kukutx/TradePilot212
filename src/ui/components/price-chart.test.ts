import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PriceHistory, PricePoint } from "../../shared/prices";
import { createTranslator } from "../i18n";
import { chartTrades } from "../views/HoldingView";
import { PriceChart, priceRanges, spreadTags, type ChartLevel } from "./price-chart";

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
  it("offers the ranges up to the first that reaches the oldest close", () => {
    expect(priceRanges(year.points)).toEqual(["1m", "3m", "6m", "1y"]);
    // Alpha Vantage's free plan: about 145 days.
    expect(priceRanges(closes("2026-05-20", 145))).toEqual(["1m", "3m", "6m"]);
    expect(priceRanges(closes("2026-09-20", 20))).toEqual(["1m"]);
    expect(priceRanges([])).toEqual([]);
  });

  it("pushes overlapping tags apart and keeps them inside the plot, in their own order", () => {
    expect(spreadTags([50, 52, 120], 10, 200, 20)).toEqual([50, 70, 120]);
    expect(spreadTags([195, 60, 199], 10, 200, 20)).toEqual([180, 60, 200]);
    expect(spreadTags([2], 10, 200, 20)).toEqual([10]);
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

  it("marks each trade by shape as well as colour, draws the levels near the prices and names the one too far away", () => {
    expect(trades.map((trade) => [trade.side, trade.text])).toEqual([["buy", "Bought 3 at $240.00"], ["sell", "Sold 2 at $330.00"], ["buy", "Bought 1 at $90.00"]]);
    const html = render();
    expect(html.match(/class="tradeMark buy"/g)).toHaveLength(1);
    expect(html.match(/class="tradeMark sell"/g)).toHaveLength(1);
    expect(html).toContain('class="priceLevel average"');
    expect(html).toContain('class="priceLevel stop"');
    expect(html).not.toContain('class="priceLevel alert"');
    expect(html).toContain("Too far from these prices to draw: Alert: Above $2,000.00.");
    // The last close and each level drawn have a tag on the axis.
    expect(html.match(/class="priceTag /g)).toHaveLength(3);
    expect(html).toContain(">464<");
    // The year's change and range, in words.
    expect(html).toContain('<strong class="positive">+364.0%</strong><span>12 months</span>');
    expect(html).toContain("High $464.00 · Low $100.00");
    expect(html).toContain('aria-label="Daily closes, 12 months: $100.00 to $464.00 (+364.0%). Trades marked: buys 1, sells 1."');
    expect(html).toContain("Daily closes from Stooq (AAPL.US)");
    // The legend names what is drawn, and only that.
    expect(html).toContain("Stop order");
    expect(html).not.toContain("Limit order");
    expect(html).not.toContain("Price alert<");
  });

  it("says so for sample prices, and in Chinese", () => {
    const html = render({ ...year, source: "sample" }, "zh-CN");
    expect(html).toContain("样例账户的模拟价格");
    expect(html).toContain("近 12 个月");
    expect(html).toContain('aria-label="近 6 个月"');
  });
});
