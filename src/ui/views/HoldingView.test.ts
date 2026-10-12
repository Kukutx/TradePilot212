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

  it("draws a day's-move alert as two levels either side of the previous close, once the close is known", () => {
    const data = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "TSLA_US_EQ", instrument: { ticker: "TSLA_US_EQ", currencyCode: "USD" },
      orders: [], alerts: [alert({ ticker: "TSLA_US_EQ", condition: "day_move", percent: 4 }), alert({ id: "fired", ticker: "TSLA_US_EQ", condition: "day_move", percent: 2, triggeredAt: "2026-10-09T15:00:00Z" })],
      day: { ticker: "TSLA_US_EQ", quantity: 0, day: "2026-10-09", previousClose: { date: "2026-10-08", close: 250, source: "stooq" }, change: 0.01 },
      timestamp: "2026-10-09T16:00:00Z",
    } as unknown as HoldingDetail;
    const levels = priceLevels(data, createTranslator("en"), "en");
    expect(levels.map((level) => [level.price, level.label])).toEqual([[260, "Alert: day's move +4% from the close"], [240, "Alert: day's move -4% from the close"]]);
    expect(priceLevels({ ...data, day: undefined }, createTranslator("en"), "en")).toEqual([]);
  });

  it("says a day's-move alert that fired arms itself again on the next trading day", () => {
    const data = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "TSLA_US_EQ", instrument: { ticker: "TSLA_US_EQ", currencyCode: "USD" },
      orders: [], journal: [], timestamp: "2026-10-09T16:00:00Z",
      alerts: [alert({ ticker: "TSLA_US_EQ", condition: "day_move", percent: 2, triggeredAt: "2026-10-09T15:00:00Z", triggeredPrice: 256.1, triggeredDay: "2026-10-09" })],
    } as unknown as HoldingDetail;
    const html = renderToStaticMarkup(createElement(HoldingView, {
      data, locale: "zh-CN", t: createTranslator("zh-CN"), writeEnabled: false, busy: false,
      onBack: () => {}, onTrade: () => {}, onCancel: () => {}, onSaveAlert: async () => true, onDeleteAlert: () => {}, onRearmAlert: () => {}, onSaveNote: async () => true, onDeleteNote: () => {},
    }));
    expect(html).toContain("<strong>当日涨跌幅达到 2%</strong>");
    expect(html).toContain("下一个交易日自动重新启用");
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

  it("gives a holding's day under its value, and the change alone under the price of one not held", () => {
    const base = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "AAPL_US_EQ", instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" },
      accountCurrency: "EUR", orders: [], alerts: [], journal: [], timestamp: "2026-10-10T09:00:00Z",
    } as unknown as HoldingDetail;
    const render = (data: HoldingDetail, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(HoldingView, {
      data, locale, t: createTranslator(locale), writeEnabled: false, busy: false,
      onBack: () => {}, onTrade: () => {}, onCancel: () => {}, onSaveAlert: async () => true, onDeleteAlert: () => {}, onRearmAlert: () => {}, onSaveNote: async () => true, onDeleteNote: () => {},
    }));
    const position = { instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" }, quantity: 12, quantityAvailableForTrading: 12, quantityInPies: 0, averagePricePaid: 168.4, currentPrice: 231.55, walletImpact: { currentValue: 2556.31, unrealizedProfitLoss: 697.17 } };
    const day = { ticker: "AAPL_US_EQ", currencyCode: "USD", quantity: 12, price: 231.55, day: "2026-10-09", previousClose: { date: "2026-10-08", close: 222.8, source: "stooq" }, change: 0.039273, profitLoss: -12.5, base: 2459.71, bought: 2 };
    const held = render({ ...base, position, day } as unknown as HoldingDetail);
    // Shares bought above the close lost more than the rest made: each figure has its own sign.
    expect(held).toContain('<div class="dayTotal dayLine" title="Shares traded on the day count from their fill price. Amounts at today&#x27;s exchange rates."><b><span class="negative">-€12.50 </span><span class="positive">(+3.93%)</span></b><span>Move on Fri, Oct 9, the last session');
    expect(held).toContain('<small class="daySince">Since the close on Thu, Oct 8: $222.80</small>');
    const quoted = render({ ...base, quote: { price: 231.55, asOf: "2026-10-09T20:00:00Z", source: "stooq", symbol: "AAPL.US" }, day: { ...day, quantity: 0, profitLoss: undefined, base: undefined, bought: undefined } } as HoldingDetail, "zh-CN");
    expect(quoted).toContain('<div class="dayTotal dayLine"><b><span class="positive">+3.93%</span></b><span>上个交易日（10月9日周五）的涨跌</span>');
    // Without a quote there is no price to set it under.
    expect(render({ ...base, day: { ...day, quantity: 0, profitLoss: undefined } } as HoldingDetail)).not.toContain("dayLine");
    // Sold out on the day: what the sells made, without a price to compare.
    const sold = render({ ...base, day: { ...day, quantity: 0, price: undefined, change: undefined, profitLoss: -27.6, bought: undefined, sold: 3 } } as HoldingDetail);
    expect(sold).toContain('<b><span class="negative">-€27.60</span></b>');
    // A holding without an exchange rate gives the change, and why there is no amount.
    const noRate = render({ ...base, position, day: { ...day, profitLoss: undefined, bought: undefined, missing: "fx", problem: "No exchange rate from USD to EUR." } } as unknown as HoldingDetail);
    expect(noRate).toContain('<div class="dayTotal dayLine" title="No exchange rate from USD to EUR."><b><span class="positive">+3.93%</span></b>');
  });
});
