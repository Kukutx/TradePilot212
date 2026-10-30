import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderStatusReport } from "../../shared/contracts";
import type { AutomationOverview } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { AutomationView, TradingRules, yearStartLabel } from "./AutomationView";
import { ExportView, OrderStatusView } from "./ToolViews";

const noop = () => {};
const en = createTranslator("en");

describe("the order status page", () => {
  const render = (data: OrderStatusReport, writeEnabled = true) => renderToStaticMarkup(createElement(OrderStatusView, { data, locale: "en", t: en, busy: false, writeEnabled, onCancel: noop, onOpen: noop, onRefresh: noop }));
  const base = { kind: "order_status", environment: "demo", orderId: "42", timestamp: "2026-10-30T12:00:00Z" } as const;

  it("shows an open order with how much of it filled, and offers to cancel it", () => {
    const html = render({ ...base, state: "partly_filled", order: { id: 42, ticker: "AAPL_US_EQ", side: "BUY", type: "LIMIT", quantity: 4, filledQuantity: 1, limitPrice: 210, currency: "USD" }, fills: [] });
    expect(html).toContain("Order 42");
    expect(html).toContain("Partly filled");
    expect(html).toContain("1 / 4");
    expect(html).toContain('aria-valuenow="0.25"');
    expect(html).toContain("Limit price $210.00");
    expect(html).toContain(">Review cancel</button>");
    // Without order tools the page only reads.
    expect(render({ ...base, state: "open", order: { id: 42, ticker: "AAPL_US_EQ", quantity: 1 }, fills: [] }, false)).not.toContain("Review cancel");
  });

  it("gives a filled order's fills, average price and value, and nothing to cancel", () => {
    const html = render({ ...base, state: "filled", order: { id: 42, ticker: "AAPL_US_EQ", side: "SELL", type: "MARKET", quantity: -3, currency: "USD" }, fills: [
      { filledAt: "2026-10-29T15:00:00Z", quantity: 1, price: 230, netValue: 200, currency: "EUR" },
      { filledAt: "2026-10-29T15:00:01Z", quantity: 2, price: 233, netValue: 405, currency: "EUR" },
    ] });
    expect(html).toContain("Filled");
    expect(html).toContain(">Sell</b>");
    expect(html).toContain("$232.00");
    expect(html).toContain("€605.00");
    expect(html).not.toContain("Review cancel");
  });

  it("averages over the fills that have a price, and shows a dash for what is not known", () => {
    const html = render({ ...base, state: "filled", order: { id: 42, ticker: "AAPL_US_EQ", side: "BUY", quantity: 3, filledQuantity: 3, currency: "USD" }, fills: [{ quantity: 2, price: 100 }] });
    expect(html).toContain("$100.00");
    expect(html).toMatch(/Value filled<\/span><strong[^>]*>—/);
  });

  it("reads an order by amount: a negative value is a sell, and it fills toward its value", () => {
    const html = render({ ...base, state: "partly_filled", order: { id: 42, ticker: "AAPL_US_EQ", strategy: "VALUE", value: -500, filledValue: -125, filledQuantity: 0.5, currency: "USD" }, fills: [] });
    expect(html).toContain(">Sell</b>");
    expect(html).toContain("$125.00 / $500.00");
    expect(html).toContain('aria-valuenow="0.25"');
  });

  it("does not offer to cancel again, or send the user to the history, right after a cancellation", () => {
    const sent = (data: OrderStatusReport) => renderToStaticMarkup(createElement(OrderStatusView, { data, locale: "en", t: en, busy: false, writeEnabled: true, justCancelled: true, onCancel: noop }));
    const stillOpen = sent({ ...base, state: "open", order: { id: 42, ticker: "AAPL_US_EQ", quantity: 1 }, fills: [] });
    expect(stillOpen).not.toContain("Review cancel");
    expect(stillOpen).toContain("can take a moment");
    const between = sent({ ...base, state: "not_found", fills: [] });
    expect(between).toContain("can take a moment");
    expect(between).not.toContain("an older order is in Trade history");
    expect(sent({ ...base, state: "cancelled", order: { id: 42, ticker: "AAPL_US_EQ", quantity: 1 }, fills: [] })).not.toContain("can take a moment");
  });

  it("says where to look for an order it cannot find", () => {
    expect(render({ ...base, state: "not_found", fills: [] })).toContain("an older order is in Trade history");
  });
});

describe("the CSV reports page", () => {
  it("lists the reports newest first, in words, with Read for the finished ones", () => {
    const html = renderToStaticMarkup(createElement(ExportView, { data: { kind: "history_export", environment: "demo", reports: [
      { reportId: 7, status: "Finished", timeFrom: "2025-01-01T00:00:00Z", timeTo: "2025-12-31T00:00:00Z" },
      { reportId: 9, status: "Processing", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-06-30T00:00:00Z" },
      { reportId: 8, status: "Failed" },
    ] }, locale: "en", t: en, busy: false, onRead: noop }));
    expect(html.indexOf("Report 9")).toBeLessThan(html.indexOf("Report 8"));
    expect(html.indexOf("Report 8")).toBeLessThan(html.indexOf("Report 7"));
    for (const word of ["Ready", "Being built", "Failed"]) expect(html).toContain(`>${word}</span>`);
    expect(html.match(/>Read<\/button>/g)).toHaveLength(1);
  });

  it("adds up a report it read, and says when one is still being built", () => {
    const summary = {
      rows: 1, actions: [{ action: "Deposit", count: 1, totals: { EUR: 4000 } }], charges: [{ name: "Withholding tax", totals: { USD: 12.08, GBX: 648 } }],
      interest: { EUR: 6.4 }, dividends: { EUR: 106.2 }, result: { EUR: 132 }, columns: [],
    };
    const html = renderToStaticMarkup(createElement(ExportView, { data: { kind: "history_export", environment: "demo", report: { reportId: 11, status: "Finished", timeFrom: "2025-10-30T00:00:00Z", timeTo: "2026-10-30T00:00:00Z" }, summary }, locale: "en", t: en, busy: false }));
    expect(html).toContain("Oct 30, 2025 to Oct 30, 2026");
    expect(html).toContain("1 row");
    expect(html).toContain("+€132.00");
    expect(html).toMatch(/GBX\s648\.00 · \$12\.08/);
    const waiting = renderToStaticMarkup(createElement(ExportView, { data: { kind: "history_export", environment: "demo", report: { reportId: 12, status: "Queued" } }, locale: "zh-CN", t: createTranslator("zh-CN"), busy: false, onRead: noop }));
    expect(waiting).toContain("报表 12 还在生成");
    expect(waiting).toContain(">再读一次</button>");
  });
});

describe("the trading rules", () => {
  it("shows today's use of each daily limit as a bar, and every rule in words", () => {
    const data = {
      kind: "automation", environment: "demo", credentials: { demo: true, live: false }, plans: [], alerts: [], links: [], currency: "EUR",
      usageToday: { orders: 4, notional: 900 }, orderLimits: { notional: 5000, quantity: 0 },
      policy: { maxPositionWeight: 0.25, dailyOrderLimit: 5, dailyNotionalLimit: 1000, allowedTickers: [], blockedTickers: ["TSLA_US_EQ"], allowedTypes: ["ETF"], marketOrdersWhenClosed: false, maxReferenceAgeSeconds: 300 },
      settings: { demoAutomation: false, protectiveLinking: true, orderWatch: true, webhook: false, digestHour: null, quoteProvider: "stooq" }, timestamp: "2026-10-30T12:00:00Z",
    } satisfies AutomationOverview;
    const html = renderToStaticMarkup(createElement(TradingRules, { data, locale: "en", t: en }));
    expect(html).toContain("4 / 5");
    expect(html).toContain('class="near"');
    expect(html).toContain("€900.00 / €1,000.00");
    expect(html).toContain("25.0%");
    expect(html).toContain("€5,000.00");
    expect(html).toMatch(/Most shares in an order<\/span><strong[^>]*>No limit/);
    expect(html).toMatch(/Allowed tickers<\/span><strong[^>]*>Any/);
    expect(html).toContain("TSLA");
    expect(html).toContain("Market orders wait for the open");
    expect(html).toContain("Newer than 300 s");
  });
});

describe("the automation settings", () => {
  it("give the digest's hour in its zone, the zone days are counted in and the tax year's first day", () => {
    const data = {
      kind: "automation", environment: "demo", credentials: { demo: true, live: false }, plans: [], alerts: [], links: [], currency: "EUR",
      usageToday: { orders: 0, notional: 0 },
      policy: { maxPositionWeight: 0, dailyOrderLimit: 0, dailyNotionalLimit: 0, allowedTickers: [], blockedTickers: [], allowedTypes: [], marketOrdersWhenClosed: true, maxReferenceAgeSeconds: 0 },
      settings: { demoAutomation: false, protectiveLinking: true, orderWatch: true, webhook: true, digestHour: 7, digestTimeZone: "Europe/London", timeZone: "Europe/London", taxYearStart: "04-06", quoteProvider: "stooq" },
      timestamp: "2026-10-30T12:00:00Z",
    } satisfies AutomationOverview;
    const html = renderToStaticMarkup(createElement(AutomationView, { data, locale: "en", t: en }));
    expect(html).toContain("07:00 Europe/London");
    expect(html).toMatch(/Days counted in<\/span><strong[^>]*>Europe\/London/);
    expect(html).toMatch(/Tax year starts<\/span><strong[^>]*>April 6/);
    expect(yearStartLabel("04-06", "zh-CN")).toBe("4月6日");
  });
});
