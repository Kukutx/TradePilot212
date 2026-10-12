import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import type { HistoryOrderItem } from "../shared/history.js";
import type { JournalEntry } from "../shared/journal.js";
import { createConfig } from "./config.js";
import { journalReview, summarizeJournalReview } from "./journal-review.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

const DAY = 86_400_000;
const now = new Date("2026-10-12T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

const note = (id: string, fields: Partial<JournalEntry>): JournalEntry => ({ id, environment: "demo", ticker: "AAPL_US_EQ", createdAt: ago(1), ...fields });
const order = (id: number, ticker: string, side: "BUY" | "SELL", price: number, quantity: number, days: number, realisedProfitLoss = 0): HistoryOrderItem => ({
  order: { id, ticker, side, type: "MARKET", status: "FILLED", currency: "USD", instrument: { ticker, name: `${ticker} Inc` } },
  fill: { id: id * 10, filledAt: ago(days), price, quantity: side === "SELL" ? -quantity : quantity, walletImpact: { currency: "EUR", realisedProfitLoss } },
});

describe("journal review", () => {
  const notes = [
    note("jrn_1", { orderId: "1", thesis: "Earnings beat", tags: ["earnings"] }),
    note("jrn_2", { orderId: "2", ticker: "MSFT_US_EQ", thesis: "Trim after the run", tags: ["Earnings", "trim"] }),
    note("jrn_3", { orderId: "3", ticker: "XYZ_US_EQ", thesis: "Small bet" }),
    note("jrn_4", { orderId: "99", thesis: "Still open" }),
    note("jrn_5", { thesis: "Waiting for a pullback" }),
  ];
  const orders = [
    order(3, "XYZ_US_EQ", "BUY", 20, 5, 5),
    order(2, "MSFT_US_EQ", "SELL", 50, 2, 10, 12.5),
    order(4, "AAPL_US_EQ", "BUY", 105, 1, 20),
    order(1, "AAPL_US_EQ", "BUY", 100, 3, 40),
    // Before the window: not a fill of the period.
    order(5, "AAPL_US_EQ", "BUY", 90, 1, 400),
  ];
  const prices = new Map([["AAPL_US_EQ", 110], ["MSFT_US_EQ", 55]]);
  const window = { from: new Date(now.getTime() - 365 * DAY), to: now };

  it("sets each noted fill against the price now, in the trade's favour", () => {
    const review = summarizeJournalReview({ environment: "demo", notes, orders, window, prices, truncated: false, now });
    expect(review).toMatchObject({ kind: "journal_review", accountCurrency: "EUR", fills: 4, withNote: 3, reviewed: 0, unmatched: 1, withoutOrder: 1, due: 1, tradesTotal: 3, unpriced: ["XYZ_US_EQ"] });
    // Newest fill first. A buy gains when the price rose; a sell when it fell.
    expect(review.trades.map((trade) => [trade.entry.id, trade.side, trade.move, trade.edge, trade.days])).toEqual([
      ["jrn_3", "buy", undefined, undefined, 5],
      ["jrn_2", "sell", 0.1, -0.1, 10],
      ["jrn_1", "buy", 0.1, 0.1, 40],
    ]);
    expect(review.trades[1]).toMatchObject({ ticker: "MSFT_US_EQ", name: "MSFT_US_EQ Inc", quantity: 2, price: 50, priceNow: 55, priceCurrency: "USD", realisedProfitLoss: 12.5 });
    // A reason, no look back, a month on: due. A buy books nothing realised.
    expect(review.trades[2]).toMatchObject({ due: true });
    expect(review.trades[2]).not.toHaveProperty("realisedProfitLoss");
    expect(review.overall).toEqual({ trades: 3, priced: 2, inFavour: 1, averageEdge: 0, realisedProfitLoss: 12.5 });
    // Tags match whatever their case, named as the newest trade writes them; the trades without a tag come last.
    expect(review.tags).toEqual([
      { tag: "Earnings", trades: 2, priced: 2, inFavour: 1, averageEdge: 0, realisedProfitLoss: 12.5 },
      { tag: "trim", trades: 1, priced: 1, inFavour: 0, averageEdge: -0.1, realisedProfitLoss: 12.5 },
      { trades: 1, priced: 0, inFavour: 0, realisedProfitLoss: 0 },
    ]);
  });

  it("reviews one tag, and says the edge leaves FX and costs out", () => {
    const review = summarizeJournalReview({ environment: "demo", notes, orders, window, prices, truncated: true, tag: " #EARNINGS ", now });
    expect(review).toMatchObject({ tag: "EARNINGS", withNote: 2, withoutOrder: 0, unmatched: 0, overall: { trades: 2 } });
    const text = describePayload(review);
    expect(text).toContain("DEMO journal review");
    expect(text).toContain("tag #EARNINGS: 2 of 4 fill(s) have a note, 0 with a look back.");
    expect(text).toContain("FX and costs are left out");
    expect(text).toContain("All: 2 trade(s), 1/2 in your favour, average +0%, realised 12.5 EUR.");
    expect(text).toContain("#trim: 1 trade(s), 0/1 in your favour, average -10%, realised 12.5 EUR");
    expect(text).toContain("History was cut at the page limit");
    expect(text).toContain('MSFT_US_EQ SELL 2 @ 50 USD, now 55 (+10%, -10% in the trade\'s favour), realised 12.5; note jrn_2, why: "Trim after the run"');
    expect(text).toContain("due for a look back");
  });

  it("finds the trade just sent, past the history read a moment before", async () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const before = await journalReview(services, "demo", { to: new Date(Date.now() + DAY) });
    expect(before.withNote).toBe(0);
    expect(before.fills).toBeGreaterThan(0);

    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "AAPL", side: "buy", type: "market", quantity: 1, thesis: "Adding on the dip" });
    const sent = await services.trading.executeOrder(preview.token);
    expect(sent.journalEntryId).toMatch(/^jrn_/);
    await services.journal.update(sent.journalEntryId!, { tags: ["dip"] });

    const after = await journalReview(services, "demo", { to: new Date(Date.now() + DAY) });
    expect(after.fills).toBe(before.fills + 1);
    expect(after.withNote).toBe(1);
    // Held, so the broker prices it; a fresh buy has barely moved.
    expect(after.trades[0]).toMatchObject({ ticker: "AAPL_US_EQ", side: "buy", quantity: 1, days: 0, entry: { thesis: "Adding on the dip" } });
    expect(after.trades[0]!.priceNow).toBeGreaterThan(0);
    expect(after.tags.map((row) => row.tag)).toEqual(["dip"]);
  });
});

describe("journal review tool", () => {
  it("works without order tools and summarizes in text", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
    const server = createMcpServer(services, config, async () => "<html></html>", new Set(["trade:read"]));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);

    const history = await client.callTool({ name: "get_trade_history", arguments: { environment: "demo", ticker: "NVDA" } });
    const orderId = (history.structuredContent as { fills: Array<{ orderId?: string }> }).fills[0]!.orderId!;
    await services.journal.add({ environment: "demo", instrument: "NVDA", orderId, thesis: "AI capex", tags: ["theme"] });

    const reviewed = await client.callTool({ name: "get_journal_review", arguments: { environment: "demo", period: "all" } });
    expect(reviewed.isError).toBeFalsy();
    expect(reviewed.structuredContent).toMatchObject({ kind: "journal_review", withNote: 1, credentials: { demo: true }, tags: [{ tag: "theme", trades: 1 }] });
    const text = JSON.stringify(reviewed.content);
    expect(text).toMatch(/1 of \d+ fill\(s\) have a journal note; [01] of 1 went your way, average edge [+-]\d/);
    expect(text).toContain("#theme: 1 trade(s)");
    const none = await client.callTool({ name: "get_journal_review", arguments: { environment: "demo", tag: "missing" } });
    expect(none.structuredContent).toMatchObject({ withNote: 0, tags: [], trades: [] });
  });
});
