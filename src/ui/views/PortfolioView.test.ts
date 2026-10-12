import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardPayload } from "../../shared/contracts";
import type { PortfolioToday } from "../../shared/today";
import { createTranslator } from "../i18n";
import { PortfolioView, type TodayState } from "./PortfolioView";

const apple = {
  instrument: { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD" },
  quantity: 12, quantityAvailableForTrading: 12, quantityInPies: 0, averagePricePaid: 168.4, currentPrice: 231.55,
  walletImpact: { currency: "EUR", currentValue: 2556.31, unrealizedProfitLoss: 697.17 },
};
const coke = {
  instrument: { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO", currencyCode: "USD" },
  quantity: 25, quantityAvailableForTrading: 25, quantityInPies: 0, averagePricePaid: 64.9, currentPrice: 61.2,
  walletImpact: { currency: "EUR", currentValue: 1407.6, unrealizedProfitLoss: -85.1 },
};
const payload = {
  kind: "portfolio", appName: "TradePilot 212", environment: "demo", credentials: { live: false, demo: true },
  account: { currency: "EUR", totalValue: 7926, cash: { availableToTrade: 3962.1 }, investments: { currentValue: 3963.91, unrealizedProfitLoss: 612.07 } },
  positions: [apple, coke], orders: [], activity: [], timestamp: "2026-10-12T07:17:00Z",
} as DashboardPayload;
const today: PortfolioToday = {
  kind: "portfolio_today", environment: "demo", accountCurrency: "EUR", timestamp: "2026-10-12T07:17:05Z",
  moves: [
    { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", quantity: 12, price: 231.55, day: "2026-10-09", previousClose: { date: "2026-10-08", close: 222.8, source: "stooq" }, change: 0.039273, profitLoss: 96.6, base: 2459.71, bought: 2 },
    { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO", currencyCode: "USD", quantity: 25, price: 61.2, day: "2026-10-09", missing: "lag", problem: "stooq's closes for KO.US end on 2026-10-07." },
    { ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "USD", quantity: 0, day: "2026-10-09", previousClose: { date: "2026-10-08", close: 250, source: "stooq" }, profitLoss: -27.6, base: 690, sold: 3 },
  ],
  total: { profitLoss: 69, change: 0.0219, counted: 2, of: 3 },
};

const render = (state: TodayState | undefined, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(PortfolioView, {
  payload, locale, t: createTranslator(locale), writeEnabled: false, onCancel: () => {}, ...(state ? { today: state } : {}),
}));

describe("the dashboard's day", () => {
  it("adds the holdings' move to the overview and a Day column, naming the session when it is an earlier one", () => {
    const html = render({ data: today, loading: false });
    expect(html).toContain('<b class="positive">+€69.00 (+2.19%)</b><span>Move on Fri, Oct 9, the last session · 2 of 3');
    expect(html).toContain('<th class="dayColumn">Day</th>');
    expect(html).toContain('title="Since the close on Thu, Oct 8: $222.80 Shares traded on the day count from their fill price."><strong>+3.93%</strong><small>+€96.60</small>');
    // A holding without a move says why, for screen readers and on hover.
    expect(html).toContain('title="stooq&#x27;s closes for KO.US end on 2026-10-07.">—<span class="visuallyHidden"> the provider has no close for the last session yet</span>');
    expect(html).toContain("Sold out on the day: Tesla -€27.60");
    // On narrower screens the column gives way to a line under the price.
    expect(html).toContain('$231.55<span class="dayUnderPrice"><span class="dayCell inline positive"');
    expect(render({ data: { ...today, timestamp: "2026-10-09T15:00:00Z" }, loading: false })).toContain("<span>Today&#x27;s move · 2 of 3");
  });

  it("shows the column while the day is read, and nothing of it when it is not asked for", () => {
    const loading = render({ loading: true });
    expect(loading).toContain('<div class="dayTotal loading" aria-busy="true"><span>Today …</span></div>');
    expect(loading).toContain('<th class="dayColumn">Day</th>');
    const none = render(undefined);
    expect(none).not.toContain('<th class="dayColumn">Day</th>');
    expect(none).not.toContain("dayTotal");
  });

  it("says why there is no total, in Chinese too", () => {
    const missing = render({ data: { ...today, total: undefined, moves: [{ ...today.moves[1]!, missing: "provider", problem: "No quote provider is configured." }] }, loading: false }, "zh-CN");
    expect(missing).toContain("今日：没有行情源，取不到前收盘价");
    expect(render({ data: today, loading: false }, "zh-CN")).toContain("上个交易日（10月9日周五）的涨跌");
  });
});
