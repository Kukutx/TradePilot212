import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot } from "../../shared/contracts";
import type { CashHistory, TaxYearSummary, TradeHistory } from "../../shared/history";
import { Menu } from "../components/menu";
import { canExport, CONTEXT_LIMIT, csvText, exportFile, viewContext } from "./bridge";

const portfolio: PortfolioSnapshot = {
  kind: "portfolio", environment: "demo", credentials: { demo: true, live: false }, account: { id: 21200000, currency: "EUR", totalValue: 1000 }, writeEnabled: true,
  positions: [{
    instrument: { ticker: "VUSAl_EQ", name: "Vanguard S&P 500, \"Dist\"", shortName: "VUSA", currencyCode: "GBP", isin: "IE00B3XXRP09" },
    quantity: 3, quantityAvailableForTrading: 3, quantityInPies: 0, averagePricePaid: 80.5, currentPrice: 90.25,
    walletImpact: { currentValue: 317.1, totalCost: 283.2, unrealizedProfitLoss: 33.9 },
  }],
  orders: [{ id: 7, ticker: "AAPL_US_EQ", quantity: 1 }], activity: [], timestamp: "2026-10-31T09:00:00.000Z",
};

describe("files for the host to save", () => {
  it("writes CSV that Excel reads as UTF-8, with quoting and no formulas", () => {
    const text = csvText(["Name", "Value"], [["=HYPERLINK(\"x\")", -2.5], ["招商银行", undefined], ["a,b", 1e21]]);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1).split("\r\n")).toEqual(["Name,Value", "\"'=HYPERLINK(\"\"x\"\")\",-2.5", "招商银行,", "\"a,b\",1e+21", ""]);
  });

  it("saves the holdings, trades, cash and tax year, and says when a list holds fewer than the period", () => {
    expect(canExport(portfolio)).toBe(true);
    expect(canExport({ kind: "performance" })).toBe(false);
    const holdings = exportFile(portfolio, "csv");
    expect(holdings).toMatchObject({ name: "tradepilot-demo-holdings-2026-10-31.csv", mimeType: "text/csv", rows: 1 });
    expect(holdings.text.split("\r\n")[1]).toBe("VUSAl_EQ,\"Vanguard S&P 500, \"\"Dist\"\"\",IE00B3XXRP09,3,0,80.5,90.25,GBP,317.1,283.2,33.9,EUR");
    const json = exportFile(portfolio, "json");
    expect(json.name).toBe("tradepilot-demo-holdings-2026-10-31.json");
    // Only what the page is about: no account number, pending orders, activity or settings.
    const data = JSON.parse(json.text);
    expect(Object.keys(data).sort()).toEqual(["account", "environment", "kind", "positions", "timestamp"]);
    expect(data.account).toEqual({ currency: "EUR", totalValue: 1000 });

    const trades = {
      kind: "trade_history", environment: "live", period: { to: "2026-10-31T00:00:00Z" }, count: 40, limit: 1, truncated: false, timestamp: "2026-10-31T09:00:00Z",
      fills: [{ filledAt: "2026-10-30T14:00:00Z", ticker: "AAPL_US_EQ", side: "BUY", quantity: 2, price: 200, priceCurrency: "USD", netValue: 342.1, costs: 0.5 }],
      totals: { buys: 1, sells: 0, bought: 342.1, sold: 0, realised: 0, costs: 0.5, currency: "EUR" },
    } as TradeHistory;
    expect(exportFile(trades, "csv")).toMatchObject({ name: "tradepilot-live-trades-2026-10-31.csv", rows: 1, of: 40 });
    expect(exportFile(trades, "csv").text.split("\r\n")[1]).toBe("2026-10-30T14:00:00Z,AAPL_US_EQ,,BUY,,2,200,USD,342.1,,0.5,,EUR,");
    // A journal note is the user's own, and stays out of a file of trades.
    expect(JSON.parse(exportFile({ ...trades, journal: [{ note: "private" }] } as TradeHistory, "json").text)).not.toHaveProperty("journal");
    expect(exportFile({ ...trades, truncated: true }, "csv").partial).toEqual(["historyCut"]);

    const cash = { kind: "cash_history", environment: "demo", period: { to: "x" }, items: [{ date: "2026-10-01", type: "DEPOSIT", amount: 500, currency: "EUR" }], count: 1, totals: {}, currency: "EUR", truncated: false, timestamp: "2026-10-31T09:00:00Z" } as CashHistory;
    expect(exportFile(cash, "csv").of).toBeUndefined();

    const tax = {
      kind: "tax_year", environment: "demo", accountCurrency: "GBP", year: 2026, yearStart: "04-06", timeZone: "Europe/London", firstDay: "2026-04-06", lastDay: "2027-04-05",
      period: { from: "", to: "" }, ended: false, disposals: { count: 1, proceeds: 100, gains: 10, losses: 0, net: 10 }, byTicker: [{ ticker: "VUSAl_EQ", disposals: 1, proceeds: 100, realizedProfitLoss: 10 }],
      income: { dividends: 0, interest: 0 }, costs: { total: 0, byType: [] }, truncated: false, notes: [], timestamp: "2026-10-31T09:00:00Z",
      ukMatching: { complete: true, notes: [], byTicker: [
        { ticker: "VUSAl_EQ", disposals: 1, quantity: 1, proceeds: 100, cost: 92, gain: 8, sameDay: 0, thirtyDay: 0, pool: 1, unmatched: 0, realizedProfitLoss: 10 },
        { ticker: "VUSA_EQ", disposals: 1, quantity: 1, proceeds: 50, cost: 40, gain: 10, sameDay: 1, thirtyDay: 0, pool: 0, unmatched: 0, realizedProfitLoss: 9 },
      ] },
    } as unknown as TaxYearSummary;
    const year = exportFile(tax, "csv");
    expect(year.name).toBe("tradepilot-demo-tax-year-2026-04-06-2026-10-31.csv");
    expect(year.text.split("\r\n").slice(1, 3)).toEqual(["VUSAl_EQ,1,100,10,1,100,92,8,0,0,1,0,GBP", "VUSA_EQ,1,,,1,50,40,10,1,0,0,0,GBP"]);
    expect(year.partial).toBeUndefined();
    // An estimate says so in the file, below the rows, as the page does.
    const estimate = exportFile({ ...tax, notes: ["Interest is counted when paid."], ukMatching: { ...tax.ukMatching!, complete: false, provisional: true, notes: [] } }, "csv");
    expect(estimate.partial).toEqual(["matchingIncomplete", "matchingProvisional"]);
    expect(estimate.text.split("\r\n").slice(3, 8)).toEqual([
      "",
      "\"Note: Not every sale could be matched and valued by the UK rules: an estimate, check before filing.\"",
      "Note: The year's last sales can still be matched with buys in the next 30 days: the UK figures can change.",
      "Note: Interest is counted when paid.",
      "",
    ]);
  });
});

describe("what the model is told", () => {
  it("names the page and the account, with the page's own summary, kept short", () => {
    const text = viewContext({ page: "Holdings", environment: "demo", sample: true }, portfolio);
    expect(text).toMatch(/^The user is looking at TradePilot's Holdings page in the widget, for the sample \(simulated\) account\. What the page shows:\n/);
    expect(viewContext({ page: "trade review", environment: "live", sample: false, note: "Nothing is placed until the user confirms it in the widget." }, undefined))
      .toBe("The user is looking at TradePilot's trade review page in the widget, for the Live (real money) account. Nothing is placed until the user confirms it in the widget.");
    expect(text.split("\n").length).toBeGreaterThan(1);
    const long = viewContext({ page: "Holdings", environment: "live", sample: false }, { ...portfolio, positions: Array.from({ length: 400 }, () => portfolio.positions[0]!) });
    expect(long).toContain("Live (real money)");
    expect(long.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
  });
});

describe("the widget's own menu", () => {
  it("is a menu button with its items hidden until opened", () => {
    const html = renderToStaticMarkup(createElement(Menu, { label: "Ask in the chat", items: [{ id: "a", label: "First" }, { id: "b", label: "Second" }], onChoose: () => {}, children: "Ask" }));
    expect(html).toMatch(/<button type="button" class="iconAction" aria-haspopup="menu" aria-expanded="false" aria-controls="([^"]+)" aria-label="Ask in the chat" title="Ask in the chat">Ask<\/button>/);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<ul id="${controls}" role="menu" aria-label="Ask in the chat" hidden=""`);
    // One item in the tab order at a time: the menu is entered with the arrows.
    expect([...html.matchAll(/role="menuitem" tabindex="(-?\d)"/g)].map((match) => match[1])).toEqual(["0", "-1"]);
  });
});
