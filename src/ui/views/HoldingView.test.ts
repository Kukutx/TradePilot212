import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PriceAlert } from "../../shared/automation";
import type { HoldingDetail } from "../../shared/holding";
import { createTranslator } from "../i18n";
import { HoldingView, priceLevels } from "./HoldingView";

const alert = (fields: Partial<PriceAlert>): PriceAlert => ({ id: `alt_${fields.condition}`, environment: "demo", ticker: "NVDA_US_EQ", condition: "below", createdAt: "2026-10-01T00:00:00Z", ...fields });

describe("holding price levels", () => {
  it("lists the last price, average cost, orders and armed alert levels, highest first", () => {
    const data = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "NVDA_US_EQ", instrument: { ticker: "NVDA_US_EQ", currencyCode: "USD" },
      position: { instrument: { ticker: "NVDA_US_EQ", name: "NVIDIA", currencyCode: "USD" }, quantity: 20, quantityAvailableForTrading: 15, quantityInPies: 0, averagePricePaid: 100, currentPrice: 125 },
      orders: [
        { id: 1, ticker: "NVDA_US_EQ", type: "STOP", side: "SELL", quantity: -5, stopPrice: 110 },
        { id: 2, ticker: "NVDA_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -5, stopPrice: 105, limitPrice: 100 },
        { id: 3, ticker: "NVDA_US_EQ", type: "LIMIT", side: "BUY", quantity: 2, limitPrice: 95 },
        { id: 4, ticker: "NVDA_US_EQ", type: "MARKET", side: "BUY", quantity: 1 },
      ],
      alerts: [
        alert({ condition: "trailing_drop", percent: 10, highWatermark: 140 }),
        alert({ condition: "gain_percent", percent: 50 }),
        alert({ condition: "above", price: 200, triggeredAt: "2026-10-05T00:00:00Z" }),
      ],
      timestamp: "2026-10-11T00:00:00Z",
    } as unknown as HoldingDetail;
    const levels = priceLevels(data, createTranslator("en"), "en");
    expect(levels.map((level) => [level.kind, level.price])).toEqual([
      ["alert", 150], // 50% gain on a cost of 100
      ["alert", 126], // 10% below the high of 140
      ["last", 125],
      ["stop", 110],
      ["stop", 105], // a stop-limit sits at its trigger
      ["average", 100],
      ["limit", 95],
    ]);
    expect(levels.find((level) => level.kind === "limit")?.label).toBe("Buy Limit · 2");
    expect(levels[0]?.label).toBe("Alert: Gain vs cost of 50%");
  });

  it("has only orders and price alerts for an instrument that is not held", () => {
    const data = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "TSLA_US_EQ", instrument: { ticker: "TSLA_US_EQ" },
      orders: [{ id: 1, ticker: "TSLA_US_EQ", type: "LIMIT", side: "BUY", quantity: 3, limitPrice: 215 }],
      alerts: [alert({ ticker: "TSLA_US_EQ", condition: "below", price: 200 }), alert({ ticker: "TSLA_US_EQ", condition: "loss_percent", percent: 10 })],
      timestamp: "2026-10-11T00:00:00Z",
    } as unknown as HoldingDetail;
    expect(priceLevels(data, createTranslator("zh-CN"), "zh-CN").map((level) => level.label)).toEqual(["买入限价 · 3", "提醒：低于或等于"]);
  });

  it("draws the price chart from the closes, or says in the viewer's language why there is none", () => {
    const base = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "AAPL_US_EQ", instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" },
      orders: [], alerts: [], journal: [], timestamp: "2026-10-11T00:00:00Z",
      history: { from: "2025-10-11T00:00:00Z", fills: [{ orderId: "9", filledAt: "2026-10-02T14:00:00Z", side: "BUY", quantity: 1, price: 101, priceCurrency: "USD" }], dividends: [], dividendTotal: 0, dividendCount: 0, fillsTruncated: false, dividendsTruncated: false },
    } as unknown as HoldingDetail;
    const render = (data: HoldingDetail, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(HoldingView, {
      data, locale, t: createTranslator(locale), writeEnabled: false, busy: false,
      onBack: () => {}, onTrade: () => {}, onCancel: () => {}, onSaveAlert: async () => true, onDeleteAlert: () => {}, onRearmAlert: () => {}, onSaveNote: async () => true, onDeleteNote: () => {},
    }));
    const charted = render({ ...base, prices: { source: "stooq", symbol: "AAPL.US", points: [{ date: "2026-10-01", close: 100 }, { date: "2026-10-02", close: 101.5 }] } });
    expect(charted).toContain('class="chartFigure priceChart"');
    expect(charted.match(/class="tradeMark buy"/g)).toHaveLength(1);
    expect(render({ ...base, pricesMissing: "provider", pricesProblem: "No quote provider is configured" }, "zh-CN")).toContain("还没有价格走势图：没有设置行情源");
    expect(render(base)).not.toContain("priceChart");
  });
});
