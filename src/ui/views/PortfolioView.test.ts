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
    expect(html).toContain('<th class="dayColumn" aria-sort="none"><button type="button" class="sortHeader">Day</button></th>');
    expect(html).toContain('title="Since the close on Thu, Oct 8: $222.80 Shares traded on the day count from their fill price."><strong class="positive">+3.93%</strong><small class="positive">+€96.60</small><span class="visuallyHidden"> Since the close on Thu, Oct 8: $222.80</span>');
    // A holding without a move says why, for screen readers and on hover.
    expect(html).toContain('title="stooq&#x27;s closes for KO.US end on 2026-10-07.">—<span class="visuallyHidden"> the provider has no close for the last session yet</span>');
    expect(html).toContain("Sold out on the day: Tesla -€27.60");
    // On narrower screens the column gives way to a line under the price.
    expect(html).toContain('$231.55<span class="dayUnderPrice"><span class="dayCell inline"');
    // The phone card writes the close out and the reason a holding has no move.
    expect(html).toContain('<small class="daySince">Since the close on Thu, Oct 8: $222.80</small>');
    expect(html).toContain('<span class="mutedInline dayMissing" title="stooq&#x27;s closes for KO.US end on 2026-10-07.">the provider has no close for the last session yet</span>');
    expect(render({ data: { ...today, timestamp: "2026-10-09T15:00:00Z" }, loading: false })).toContain("<span>Today&#x27;s move · 2 of 3");
  });

  it("gives the price's change and the amount their own sign", () => {
    // Up on the day, but shares bought above the close lost more than the rest made.
    const html = render({ data: { ...today, moves: [{ ...today.moves[0]!, profitLoss: -12.5 }] }, loading: false });
    expect(html).toContain('<strong class="positive">+3.93%</strong><small class="negative">-€12.50</small>');
  });

  it("says when the day could not be read, without the column", () => {
    const html = render({ loading: false, failed: true });
    expect(html).toContain('<div class="dayTotal"><span>The day&#x27;s move could not be read; refresh to try again.</span></div>');
    expect(html).not.toContain("dayColumn");
    expect(html).not.toContain("dayUnderPrice");
    expect(render({ loading: false, failed: true }, "zh-CN")).toContain("没能读到当日涨跌，刷新可重试。");
  });

  it("shows the column while the day is read, and nothing of it when it is not asked for", () => {
    const loading = render({ loading: true });
    expect(loading).toContain('<div class="dayTotal loading" aria-busy="true"><span>Today …</span></div>');
    expect(loading).toContain('<th class="dayColumn" aria-sort="none"><button type="button" class="sortHeader">Day</button></th>');
    const none = render(undefined);
    expect(none).not.toContain('<th class="dayColumn" aria-sort="none"><button type="button" class="sortHeader">Day</button></th>');
    expect(none).not.toContain("dayTotal");
  });

  it("says why there is no total, in Chinese too", () => {
    const missing = render({ data: { ...today, total: undefined, moves: [{ ...today.moves[1]!, missing: "provider", problem: "No quote provider is configured." }] }, loading: false }, "zh-CN");
    expect(missing).toContain("今日：没有行情源，取不到前收盘价");
    expect(render({ data: today, loading: false }, "zh-CN")).toContain("上个交易日（10月9日周五）的涨跌");
  });

  it("offers the table or a map, and an order: by a column header or the menu, the day's only when there is one", () => {
    const html = render({ data: today, loading: false });
    expect(html).toContain('<div class="segmented" role="radiogroup" aria-label="Show holdings as"><button type="button" role="radio" aria-checked="true" tabindex="0" class="active">Table</button><button type="button" role="radio" aria-checked="false" tabindex="-1" class="">Map</button></div>');
    expect(html).toMatch(/role="combobox"[^>]*aria-label="Sort"[^>]*><span class="selectValue" title="Trading 212&#x27;s order">Trading 212&#x27;s order<\/span>/);
    expect(html).toMatch(/aria-selected="true" data-value="default"[^>]*><span>Trading 212&#x27;s order<\/span>/);
    expect(html).toMatch(/aria-selected="false" data-value="day-asc"[^>]*><span>Day&#x27;s move, worst first<\/span>/);
    expect(html).toContain('<th aria-sort="none"><button type="button" class="sortHeader">Position value</button></th>');
    const none = render(undefined, "zh-CN");
    expect(none).not.toContain("day-desc");
    expect(none).toMatch(/data-value="pnl-asc"[^>]*><span>盈亏从低到高<\/span>/);
    expect(none).toContain('aria-label="持仓显示方式"');
  });

  it("opens in the viewer's last order and view", () => {
    const saved: Record<string, string> = { "tradepilot212.holdingsSort": "value-asc", "tradepilot212.holdingsView": "table" };
    const storage = { getItem: (key: string) => saved[key] ?? null, setItem: (key: string, value: string) => { saved[key] = value; } };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      const sorted = render({ data: today, loading: false });
      expect(sorted.indexOf("<strong>Coca-Cola</strong>")).toBeLessThan(sorted.indexOf("<strong>Apple</strong>"));
      expect(sorted).toContain('<th aria-sort="ascending"><button type="button" class="sortHeader active">Position value<span class="sortArrow" aria-hidden="true">↑</span></button></th>');
      saved["tradepilot212.holdingsView"] = "map";
      const map = render({ data: today, loading: false });
      expect(map).toContain('class="holdingsMap"');
      expect(map).not.toContain("positionsTable");
      // The map's colour choice takes the place of the order.
      expect(map).toContain('aria-label="Colour shows"');
      expect(map).not.toContain("sortSelect");
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("the result by source", () => {
  const split = { ...payload, positions: [
    { ...apple, walletImpact: { ...apple.walletImpact, fxImpact: -60.62 } },
    { ...coke, walletImpact: { ...coke.walletImpact, fxImpact: -48.67 } },
  ] } as DashboardPayload;
  const view = (data: DashboardPayload, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(PortfolioView, { payload: data, locale, t: createTranslator(locale), writeEnabled: false, onCancel: () => {} }));

  it("splits the account's result into price and exchange rate, adding up to it, and gives each holding's rate part", () => {
    const html = view(split);
    expect(html).toContain('<dl class="resultSplit" aria-label="Unrealized P/L by source">');
    // 612.07 in all, 109.29 of it lost to the rate: the price made 721.36.
    expect(html).toMatch(/<dt>Price<\/dt>.*?<dd class="resultSplitValue positive">\+€721\.36<\/dd>/);
    expect(html).toMatch(/<dt>Exchange rate<\/dt>.*?<dd class="resultSplitValue negative">-€109\.29<\/dd>/);
    // The larger part fills its bar; the other is scaled to it.
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('<small class="pnlFx">FX -€60.62</small>');
    expect(view(split, "zh-CN")).toContain('<small class="pnlFx">汇率 -€48.67</small>');
  });

  it("shows no split without Trading 212's rate part, or when the rate moved nothing", () => {
    expect(view(payload)).not.toContain("resultSplit");
    expect(view(payload)).not.toContain("pnlFx");
    const flat = { ...payload, positions: [{ ...apple, walletImpact: { ...apple.walletImpact, fxImpact: 0 } }] } as DashboardPayload;
    expect(view(flat)).not.toContain("resultSplit");
    // One holding without its rate part leaves the account unsplit; the other still gives its own.
    const mixed = { ...payload, positions: [split.positions[0], coke] } as DashboardPayload;
    expect(view(mixed)).not.toContain("resultSplit");
    expect(view(mixed)).toContain('<small class="pnlFx">FX -€60.62</small>');
  });
});
