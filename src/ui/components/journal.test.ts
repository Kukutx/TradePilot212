import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HoldingDetail } from "../../shared/holding";
import type { JournalEntry } from "../../shared/journal";
import { createTranslator } from "../i18n";
import { HoldingView } from "../views/HoldingView";
import { noteOrder, parseTags } from "./journal";

const t = createTranslator("en");
const note = (fields: Partial<JournalEntry>): JournalEntry => ({ id: "jrn_1", environment: "demo", ticker: "AAPL_US_EQ", createdAt: "2026-10-10T08:00:00Z", ...fields });

describe("journal notes", () => {
  it("reads tags separated by either comma or new lines", () => {
    expect(parseTags("earnings, #breakout，财报、 earnings\nlong-term")).toEqual(["earnings", "breakout", "财报", "long-term"]);
    expect(parseTags(" , ")).toEqual([]);
  });

  it("names the fill a note is about, else the order as sent, else its id", () => {
    const fills = [{ orderId: "90001", side: "SELL", quantity: -2, price: 231.5, priceCurrency: "USD", filledAt: "2026-09-01T14:00:00Z" }];
    expect(noteOrder(note({ orderId: "90001" }), fills, "en", t)).toEqual({ label: "Sell 2 · $231.50", side: "sell", at: "2026-09-01T14:00:00Z" });
    expect(noteOrder(note({ orderId: "5", order: { side: "buy", type: "limit", quantity: 3 } }), fills, "en", t)).toEqual({ label: "Buy 3 · Limit", side: "buy" });
    expect(noteOrder(note({ orderId: "5" }), fills, "en", t)).toEqual({ label: "Order 5" });
    expect(noteOrder(note({}), fills, "en", t)).toBeUndefined();
  });

  it("shows the notes on the holding page and each fill's reason", () => {
    const data = {
      kind: "holding", environment: "demo", credentials: { demo: true, live: false }, ticker: "AAPL_US_EQ", instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" },
      accountCurrency: "EUR", orders: [], alerts: [],
      journal: [
        note({ id: "jrn_2", thesis: "Watch the next earnings", tags: ["earnings"] }),
        note({ id: "jrn_1", orderId: "90001", thesis: "Trim near the target weight", review: "Sold too early", updatedAt: "2026-10-11T08:00:00Z" }),
      ],
      journalTotal: 30,
      history: {
        from: "2025-10-11T00:00:00Z", dividends: [], dividendTotal: 0, dividendCount: 0, fillsTruncated: false, dividendsTruncated: false,
        fills: [
          { orderId: "90001", side: "SELL", quantity: -2, price: 231.5, priceCurrency: "USD", filledAt: "2026-09-01T14:00:00Z", netValue: 430, accountCurrency: "EUR" },
          { orderId: "90002", side: "BUY", quantity: 3, price: 190, priceCurrency: "USD", filledAt: "2026-06-01T14:00:00Z", netValue: 520, accountCurrency: "EUR" },
        ],
      },
      timestamp: "2026-10-11T09:00:00Z",
    } as unknown as HoldingDetail;
    const html = renderToStaticMarkup(createElement(HoldingView, {
      data, locale: "en", t, writeEnabled: true, busy: false,
      onBack: () => {}, onTrade: () => {}, onCancel: () => {}, onSaveAlert: async () => true, onDeleteAlert: () => {}, onRearmAlert: () => {},
      onSaveNote: async () => true, onDeleteNote: () => {},
    }));
    expect(html).toContain("<h2>Trade journal</h2>");
    expect(html).toContain("#earnings");
    // The note on a listed fill is dated by the fill and names it; it offers a look back only when it has none.
    expect(html).toMatch(/<strong>Sep 1, 2026<\/strong><span class="journalOrder sell">Sell 2 · \$231\.50<\/span>/);
    expect(html.match(/Add a look back/g)).toHaveLength(1);
    expect(html).toContain("edited Oct 11, 2026");
    expect(html).toContain("Showing 2 of 30 notes: the newest and those on the fills listed.");
    // The fill with a note shows its reason; the other offers to write one.
    expect(html).toContain('<p class="fillNote" title="Trim near the target weight"><span>Why</span>Trim near the target weight</p>');
    expect(html.match(/class="inlineLink"/g)).toHaveLength(1);
  });
});
