import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CashHistory, TaxYearSummary, TradeHistory } from "../../shared/history";
import { createTranslator } from "../i18n";
import { cashSigned, cashTypeLabel, CashHistoryView, TaxYearView, taxRuleOf, TradeHistoryView } from "./HistoryView";

const noop = () => {};
const trades: TradeHistory = {
  kind: "trade_history", environment: "demo", period: { from: "2026-01-01T00:00:00.000Z", to: "2026-10-30T12:00:00.000Z" }, truncated: false, timestamp: "2026-10-30T12:00:00Z",
  count: 3, limit: 200, totals: { buys: 2, sells: 1, bought: 536.4, sold: 410.5, realised: 52.25, costs: 0.92, currency: "EUR" },
  fills: [
    { orderId: "3", ticker: "AAPL_US_EQ", name: "Apple", side: "SELL", type: "LIMIT", filledAt: "2026-10-29T15:00:00Z", quantity: -2, price: 230, priceCurrency: "USD", netValue: 410.5, accountCurrency: "EUR", realisedProfitLoss: 52.25, costs: 0.62 },
    { orderId: "2", ticker: "AAPL_US_EQ", name: "Apple", side: "BUY", type: "MARKET", filledAt: "2026-10-29T14:00:00Z", quantity: 1, price: 228, priceCurrency: "USD", netValue: -196.4, accountCurrency: "EUR", costs: 0.3 },
    { orderId: "1", ticker: "VUSAl_EQ", name: "Vanguard S&P 500", side: "BUY", type: "MARKET", filledAt: "2026-09-01T09:00:00Z", quantity: 3, price: 98, priceCurrency: "GBP", netValue: -340, accountCurrency: "EUR", costs: 0 },
  ],
  unfilled: [{ orderId: "9", ticker: "MSFT_US_EQ", side: "BUY", type: "LIMIT", status: "CANCELLED", createdAt: "2026-08-01T10:00:00Z", quantity: 1, limitPrice: 300, priceCurrency: "USD" }],
};

describe("the trade history page", () => {
  const render = (locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(TradeHistoryView, {
    data: { ...trades, journal: [{ id: "j", environment: "demo", ticker: "AAPL_US_EQ", orderId: "3", thesis: "Took profit at resistance", createdAt: "2026-10-29T15:00:00Z" }] },
    locale, t: createTranslator(locale), period: "ytd", busy: false, onPeriod: noop, onKind: noop, onOpen: noop,
  }));

  it("adds up the realised result, the money bought and sold and the costs, and lists the fills a day at a time", () => {
    const html = render();
    expect(html).toContain("+€52.25");
    expect(html).toContain("3 fills");
    expect(html).toContain("2 buys, 1 sells");
    expect(html).toContain("€536.40");
    expect(html).toContain("€410.50");
    expect(html).toContain("€0.92");
    // Two days, newest first, each with its own heading.
    expect(html.match(/historyDayTitle/g)).toHaveLength(2);
    expect(html.indexOf("Oct 29")).toBeLessThan(html.indexOf("Sep 1"));
    // The note on the sale, and the order that never filled in its own section.
    expect(html).toContain("Took profit at resistance");
    expect(html).toContain("Orders that did not fill");
    expect(html).toContain("Cancelled");
  });

  it("shows the totals of the whole window when only the newest fills are listed, and says what the host limited it to", () => {
    const html = renderToStaticMarkup(createElement(TradeHistoryView, {
      data: { ...trades, fills: trades.fills.slice(0, 1), count: 40, totals: { ...trades.totals, buys: 30, sells: 10, realised: 1234.5 }, filter: { ticker: "AAPL_US_EQ" } },
      locale: "en", t: createTranslator("en"), period: null, busy: false, onPeriod: noop, onKind: noop, onClearFilter: noop,
    }));
    expect(html).toContain("+€1,234.50");
    expect(html).toContain("40 fills");
    expect(html).toContain("The newest 1 of 40 are listed; the totals cover all of them.");
    // The host's window is none of the switch's periods: none is checked, and the window shows with the instrument.
    expect(html).not.toContain('aria-checked="true" aria-label="Year to date"');
    expect(html).toMatch(/Only <strong>Apple · Jan 1, 2026 to Oct 30, 2026<\/strong>/);
    expect(html).toContain(">Show all</button>");
  });

  it("reads in Chinese", () => {
    const html = render("zh-CN");
    expect(html).toContain("成交记录");
    expect(html).toContain("买入 2 笔，卖出 1 笔");
  });
});

describe("the cash history page", () => {
  const cash: CashHistory = {
    kind: "cash_history", environment: "demo", period: { to: "2026-10-30T12:00:00Z" }, count: 4, currency: "EUR", truncated: false, timestamp: "2026-10-30T12:00:00Z",
    totals: { DEPOSIT: 1000, WITHDRAW: -200, DIVIDEND: 4.2, INTEREST: 1.84 },
    items: [
      { date: "2026-10-28T23:00:00Z", type: "INTEREST", amount: 1.84, currency: "EUR" },
      { date: "2026-10-15", type: "DIVIDEND", amount: 4.2, currency: "EUR", ticker: "AAPL_US_EQ", name: "Apple", quantity: 12, grossPerShare: 0.26, perShareCurrency: "USD" },
      { date: "2026-10-02T09:00:00Z", type: "WITHDRAW", amount: -200, currency: "EUR" },
    ],
  };

  it("totals each kind of movement, offers each as a filter, and says when only the newest are listed", () => {
    const html = renderToStaticMarkup(createElement(CashHistoryView, { data: cash, locale: "en", t: createTranslator("en"), period: "all", busy: false, onPeriod: noop, onKind: noop }));
    expect(html).toContain("+€806.04");
    expect(html).toContain("+€800.00");
    for (const label of ["All", "Deposits", "Withdrawals", "Dividends", "Interest"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("Apple");
    expect(html).toContain("-€200.00");
    expect(html).toContain(">Withdrawal</strong>");
    expect(html).toContain("The newest 3 of 4 are listed");
  });

  it("takes the direction of a withdrawal or deposit from its kind, whatever sign it is sent with", () => {
    const positive: CashHistory = { ...cash, totals: { DEPOSIT: 1000, WITHDRAW: 200 }, count: 1, items: [{ date: "2026-10-02T09:00:00Z", type: "WITHDRAW", amount: 200, currency: "EUR" }] };
    const html = renderToStaticMarkup(createElement(CashHistoryView, { data: positive, locale: "en", t: createTranslator("en"), period: "all", busy: false, onPeriod: noop, onKind: noop }));
    expect(html).toContain("+€800.00");
    expect(html).toContain("-€200.00");
    expect(html).not.toContain("+€200.00");
    expect(cashSigned("WITHDRAWAL", 50)).toBe(-50);
    expect(cashSigned("DEPOSIT", -50)).toBe(50);
    // A dividend or interest correction stays negative, as on the income and tax pages.
    expect(cashSigned("DIVIDEND", -4)).toBe(-4);
    expect(cashSigned("TRANSFER", -4)).toBe(-4);
  });

  it("names a kind it does not know as Trading 212 sends it", () => {
    const t = createTranslator("en");
    expect(cashTypeLabel("DEPOSIT", t)).toBe("Deposits");
    expect(cashTypeLabel("CARD_DEBIT", t)).toBe("Card debit");
  });
});

describe("the tax year page", () => {
  const year: TaxYearSummary = {
    kind: "tax_year", environment: "demo", accountCurrency: "GBP", year: 2025, yearStart: "04-06", timeZone: "Europe/London", firstDay: "2025-04-06", lastDay: "2026-04-05",
    period: { from: "2025-04-05T23:00:00Z", to: "2026-04-05T22:59:59Z" }, ended: true,
    disposals: { count: 3, proceeds: 5000, gains: 400, losses: 150, net: 250 },
    byTicker: [{ ticker: "AAPL_US_EQ", disposals: 2, proceeds: 3000, realizedProfitLoss: 400 }, { ticker: "TSLA_US_EQ", disposals: 1, proceeds: 2000, realizedProfitLoss: -150 }],
    income: { dividends: 80, interest: 20 }, costs: { total: 5, byType: [{ key: "STAMP_DUTY_RESERVE_TAX", amount: 5 }] }, truncated: false, notes: [], timestamp: "2026-10-30T12:00:00Z",
  };

  it("shows a UK year as 2025/26 with its days, the net gain and the gains and losses apart", () => {
    const html = renderToStaticMarkup(createElement(TaxYearView, { data: year, locale: "en", t: createTranslator("en"), busy: false, onKind: noop, onYear: noop, onRule: noop }));
    expect(html).toContain("2025/26");
    expect(html).toContain("Apr 6, 2025 to Apr 5, 2026");
    expect(html).toContain("+£250.00");
    expect(html).toContain("3 sales");
    expect(html).toContain("Stamp duty reserve tax");
    expect(html).toMatch(/aria-checked="true"[^>]*>UK \(6 Apr\)/);
    // The year has ended, so the next one can be shown; a running one cannot go further.
    expect(html).toMatch(/aria-label="Next tax year"(?![^>]*disabled)/);
    const running = renderToStaticMarkup(createElement(TaxYearView, { data: { ...year, ended: false }, locale: "en", t: createTranslator("en"), busy: false, onKind: noop, onYear: noop, onRule: noop }));
    expect(running).toContain("Still running");
    expect(running).toMatch(/aria-label="Next tax year" disabled/);
  });

  it("reads the rule back from the year's first day, and keeps a year that starts on another day as it is", () => {
    expect(taxRuleOf("04-06")).toBe("uk");
    expect(taxRuleOf("01-01")).toBe("calendar");
    expect(taxRuleOf("07-01")).toBeUndefined();
    const fiscal = renderToStaticMarkup(createElement(TaxYearView, {
      data: { ...year, year: 2026, yearStart: "07-01", firstDay: "2026-07-01", lastDay: "2027-06-30", ended: false }, locale: "en", t: createTranslator("en"), busy: false, onKind: noop, onYear: noop, onRule: noop,
    }));
    expect(fiscal).toContain("2026/27");
    expect(fiscal).not.toMatch(/role="radio" aria-checked="true"[^>]*>(Calendar|UK)/);
  });
});
