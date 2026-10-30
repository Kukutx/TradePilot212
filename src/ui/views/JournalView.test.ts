import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JournalReview } from "../../shared/journal";
import { createTranslator } from "../i18n";
import { JournalReviewView } from "./JournalView";

const review: JournalReview = {
  kind: "journal_review",
  environment: "demo",
  period: { to: "2026-10-12T00:00:00Z" },
  accountCurrency: "EUR",
  fills: 14,
  withNote: 2,
  overall: { trades: 2, priced: 2, inFavour: 1, averageEdge: 0.04, realisedProfitLoss: 36 },
  tags: [
    { tag: "trim", trades: 1, priced: 1, inFavour: 0, averageEdge: -0.307, realisedProfitLoss: 36 },
    { tag: "pullback", trades: 1, priced: 1, inFavour: 1, averageEdge: 0.389, realisedProfitLoss: 0 },
  ],
  reviewed: 1,
  due: 1,
  trades: [
    {
      entry: { id: "jrn_1", environment: "demo", ticker: "AAPL_US_EQ", orderId: "1", thesis: "Bought the pullback", review: "Worked", tags: ["pullback"], createdAt: "2026-09-22T00:00:00Z" },
      ticker: "AAPL_US_EQ", name: "Apple", side: "buy", quantity: 3, price: 166.72, priceCurrency: "USD", filledAt: "2026-09-22T14:00:00Z", days: 20, priceNow: 231.55, move: 0.389, edge: 0.389,
    },
    {
      entry: { id: "jrn_2", environment: "demo", ticker: "KO_US_EQ", orderId: "2", thesis: "Yield fell under 3%", tags: ["trim"], createdAt: "2026-07-12T00:00:00Z" },
      ticker: "KO_US_EQ", name: "Coca-Cola", side: "sell", quantity: 2, price: 46.82, priceCurrency: "USD", filledAt: "2026-07-12T14:00:00Z", days: 92, priceNow: 61.2, move: 0.307, edge: -0.307, realisedProfitLoss: 36, due: true,
    },
  ],
  tradesTotal: 2,
  unmatched: 1,
  withoutOrder: 2,
  unpriced: [],
  notQuoted: [],
  truncated: false,
  timestamp: "2026-10-12T00:00:00Z",
};

const render = (data: JournalReview, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(JournalReviewView, {
  data, locale, t: createTranslator(locale), period: "all", busy: false,
  onPeriod: () => {}, onTag: () => {}, onOpen: () => {}, onSaveNote: async () => true,
}));

describe("journal review view", () => {
  it("shows the edge in words as well as colour, per trade and per tag", () => {
    const html = render(review);
    expect(html).toContain('<strong class="heroValue positive">+4.0%</strong>');
    expect(html).toContain("Went your way · 1 of 2");
    expect(html).toContain('<strong title="1 of 2">1 of 2</strong>');
    expect(html).toContain('<span class="edgeBadge positive">38.9% your way</span>');
    expect(html).toContain('<span class="edgeBadge negative">30.7% against you</span>');
    expect(html).toContain("Realised +€36.00");
    // One trade, one note: singular; the bar runs left of the centre for a tag against you.
    expect(html).toContain("1 trade · 0 of 1 your way");
    expect(html).toMatch(/class="edgeFill negative" style="right:50%;width:\d+(\.\d+)?%"/);
    expect(html).toContain("1 note is on an order not among these fills");
    expect(html).toContain("2 notes are about an instrument rather than a filled order");
    // The trade due for a look back says so and offers to write it; the name opens the holding.
    expect(html.match(/Due for a look back/g)).toHaveLength(2);
    expect(html.match(/Add a look back/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open Coca-Cola"');
  });

  it("says when only one tag is shown, keeps untagged trades out of the filter, and names what was not priced", () => {
    const untagged = { tag: undefined, trades: 1, priced: 1, inFavour: 1, averageEdge: 0.1, realisedProfitLoss: 0 };
    const html = render({ ...review, tags: [...review.tags, untagged], notQuoted: ["T8_US_EQ"] });
    expect(html).toContain('<div class="reviewTag static">');
    expect(html.match(/<button type="button" class="reviewTag/g)).toHaveLength(2);
    expect(html).toContain("Not priced this time, since one look asks the quote provider about 8 instruments at most: T8.");
    expect(html).not.toContain("Only the trades tagged");
    const filtered = render({ ...review, tag: "pullback" });
    expect(filtered).toContain("Only the trades tagged #pullback");
    expect(filtered).toContain(">All trades</button>");
  });

  it("explains an empty period, in Chinese too", () => {
    const empty = { ...review, withNote: 0, overall: { trades: 0, priced: 0, inFavour: 0, realisedProfitLoss: 0 }, tags: [], trades: [], tradesTotal: 0, reviewed: 0, due: 0, unmatched: 0, withoutOrder: 0 };
    const html = render(empty);
    expect(html).toContain('<strong class="heroValue neutral">—</strong>');
    expect(html).toContain("No trade in this period has a note yet.");
    expect(html).not.toContain("By tag");
    expect(render(review, "zh-CN")).toContain("逆向 30.7%");
  });
});
