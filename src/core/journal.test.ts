import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { journalTags, journalText, MAX_JOURNAL_TEXT } from "../shared/journal.js";
import { createConfig } from "./config.js";
import { holdingDetail } from "./holding.js";
import { MAX_JOURNAL_ENTRIES } from "./journal.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  const store = new MemoryStateStore();
  return { ...createServices({ config, store, fetcher: (async () => new Response("{}")) as typeof fetch }), config, store };
}

describe("journal text", () => {
  it("trims, drops empty text and cuts without splitting a character", () => {
    expect(journalText("  why  ")).toBe("why");
    expect(journalText("   ")).toBeUndefined();
    expect(journalText(undefined)).toBeUndefined();
    const long = `${"a".repeat(MAX_JOURNAL_TEXT - 1)}😀😀`;
    expect(journalText(long)).toBe(`${"a".repeat(MAX_JOURNAL_TEXT - 1)}😀`);
  });

  it("keeps each tag once, without a leading #, at most eight", () => {
    expect(journalTags([" #Earnings", "earnings", "", "breakout"])).toEqual(["Earnings", "breakout"]);
    expect(journalTags(["  "])).toBeUndefined();
    expect(journalTags(Array.from({ length: 12 }, (_, index) => `t${index}`))).toHaveLength(8);
  });
});

describe("trade journal", () => {
  it("adds, lists newest first, updates and deletes notes", async () => {
    const { journal } = sample();
    const first = await journal.add({ environment: "demo", instrument: "AAPL", thesis: "Pullback to the average" }, new Date("2026-03-01T10:00:00Z"));
    const second = await journal.add({ environment: "demo", instrument: "NVDA", review: "Sold too early", tags: ["#exit", "Exit"] }, new Date("2026-03-02T10:00:00Z"));
    expect(first).toMatchObject({ ticker: "AAPL_US_EQ", thesis: "Pullback to the average", environment: "demo" });
    expect(second.tags).toEqual(["exit"]);
    expect((await journal.list("demo")).map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect((await journal.list("demo", { ticker: "aapl_us_eq" })).map((entry) => entry.id)).toEqual([first.id]);
    expect(await journal.list("live")).toEqual([]);

    const changed = await journal.update(first.id, { review: "Worked; scale in next time", tags: ["pullback"] }, new Date("2026-04-01T10:00:00Z"));
    expect(changed).toMatchObject({ thesis: "Pullback to the average", review: "Worked; scale in next time", tags: ["pullback"], updatedAt: "2026-04-01T10:00:00.000Z" });
    // An empty value clears that part; a note keeps a reason or a look back.
    expect(await journal.update(first.id, { thesis: "", tags: [] })).not.toHaveProperty("thesis");
    await expect(journal.update(first.id, { review: " " })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await journal.delete(second.id);
    await expect(journal.delete(second.id)).rejects.toMatchObject({ code: "JOURNAL_ENTRY_NOT_FOUND" });
    expect((await journal.list("demo")).map((entry) => entry.id)).toEqual([first.id]);
  });

  it("needs text, a numeric order id, and one note per order", async () => {
    const { journal } = sample();
    await expect(journal.add({ environment: "demo", instrument: "AAPL", thesis: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(journal.add({ environment: "demo", instrument: "AAPL", thesis: "x", orderId: "abc" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const note = await journal.add({ environment: "demo", instrument: "AAPL", thesis: "x", orderId: " 90001 " });
    expect(note.orderId).toBe("90001");
    await expect(journal.add({ environment: "demo", instrument: "AAPL", review: "y", orderId: "90001" })).rejects.toMatchObject({ code: "INVALID_INPUT", details: { entryId: note.id } });
    // Live has its own orders, so the same id there is another order.
    await expect(journal.add({ environment: "live", instrument: "AAPL", thesis: "x", orderId: "90001" })).rejects.toThrow(/credentials/i);
  });

  it("stops at the most notes it keeps", async () => {
    const { journal, store } = sample();
    for (let index = 0; index < MAX_JOURNAL_ENTRIES; index++) await store.put(`journal:jrn_${index}`, { id: `jrn_${index}`, environment: "demo", ticker: "AAPL_US_EQ", thesis: "x", createdAt: "2026-01-01T00:00:00Z" });
    await expect(journal.add({ environment: "demo", instrument: "AAPL", thesis: "one more" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await journal.recordOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1, thesis: "why" }, { order: { id: 1 } })).toBeUndefined();
  });

  it("saves an order's thesis with the order id Trading 212 gave it, and shows it on the holding and its fill", async () => {
    const services = sample();
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "AAPL", side: "buy", type: "market", quantity: 2, thesis: "  Adding before the product event; wrong below 200.  " });
    expect(preview.draft.thesis).toBe("Adding before the product event; wrong below 200.");
    expect(describePayload(preview)).toContain('Why (saved to the journal once sent): "Adding before the product event; wrong below 200."');
    const executed = await services.trading.executeOrder(preview.token);
    expect(executed.status).toBe("submitted");
    const orderId = String((executed.order as { id: number }).id);
    expect(executed.journalEntryId).toMatch(/^jrn_/);
    expect(describePayload(executed)).toContain(`saved to the trade journal as ${executed.journalEntryId}`);
    const [note] = await services.journal.list("demo", { orderIds: [orderId] });
    expect(note).toMatchObject({ id: executed.journalEntryId, ticker: "AAPL_US_EQ", orderId, order: { side: "buy", type: "market", quantity: 2 }, thesis: "Adding before the product event; wrong below 200." });

    // A past fill gets its own note; the holding lists both and each fill carries its order id.
    const history = await services.insights.tradeHistory("demo", { to: new Date() }, "AAPL", 50);
    const past = history.fills.find((fill) => fill.orderId && fill.orderId !== orderId)!;
    await services.journal.add({ environment: "demo", instrument: "AAPL_US_EQ", orderId: past.orderId!, review: "Bought the top; wait for a pullback" });
    const detail = await holdingDetail(services, "demo", "AAPL");
    expect(detail.journal.map((entry) => entry.orderId)).toEqual([past.orderId, orderId]);
    expect(detail.history?.fills.some((fill) => fill.orderId === past.orderId)).toBe(true);
    const text = describePayload(detail);
    expect(text).toContain("Journal notes (2):");
    expect(text).toContain(`order ${orderId} BUY 2 market; why: "Adding before the product event; wrong below 200."`);
    expect(text).toContain('review: "Bought the top; wait for a pullback"');
  });

  it("sends nothing to Trading 212 but the order, and an order without a thesis saves no note", async () => {
    const services = sample();
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "MSFT", side: "buy", type: "market", quantity: 1, thesis: "   " });
    expect(preview.draft).not.toHaveProperty("thesis");
    const executed = await services.trading.executeOrder(preview.token);
    expect(executed.status).toBe("submitted");
    expect(executed).not.toHaveProperty("journalEntryId");
    expect(await services.journal.list("demo")).toEqual([]);
  });

  it("leaves the thesis out of a basket's orders", async () => {
    const services = sample();
    const preview = await services.trading.prepareBasket({ environment: "demo", purpose: "custom", title: "Two buys", drafts: [{ environment: "demo", ticker: "AAPL", side: "buy", type: "market", quantity: 1, thesis: "a reason" }] });
    expect(preview.legs[0]!.draft).not.toHaveProperty("thesis");
  });
});

describe("trade journal tool", () => {
  it("works without order tools, and history lists the notes on its orders", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const services = sample();
    const server = createMcpServer(services, services.config, async () => "<html></html>", new Set(["trade:read"]));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    const history = await call("get_trade_history", { environment: "demo", ticker: "AAPL" });
    const fills = (history.structuredContent as { fills: Array<{ orderId?: string }> }).fills;
    const orderId = fills[0]!.orderId!;
    expect(orderId).toMatch(/^\d+$/);
    expect(history.structuredContent).not.toHaveProperty("journal");

    const added = await call("manage_trade_journal", { action: "add", environment: "demo", instrument: "Apple", orderId, thesis: "Bought the dip", tags: ["dip"] });
    const entry = (added.structuredContent as { entry: { id: string; ticker: string } }).entry;
    expect(entry.ticker).toBe("AAPL_US_EQ");
    expect(JSON.stringify(added.content)).toContain(`for order ${orderId}`);

    const again = await call("get_trade_history", { environment: "demo", ticker: "AAPL" });
    expect((again.structuredContent as { journal?: Array<{ id: string }> }).journal?.map((note) => note.id)).toEqual([entry.id]);
    expect(JSON.stringify(again.content)).toContain("1 with a journal note");
    expect(JSON.stringify(again.content)).toContain('why: \\"Bought the dip\\"');

    const updated = await call("manage_trade_journal", { action: "update", environment: "demo", entryId: entry.id, review: "Too early" });
    expect(updated.structuredContent).toMatchObject({ entry: { thesis: "Bought the dip", review: "Too early" } });
    const listed = await call("manage_trade_journal", { action: "list", environment: "demo", instrument: "Apple", limit: 1 });
    expect(listed.structuredContent).toMatchObject({ kind: "trade_journal", total: 1, entries: [{ id: entry.id }] });
    expect((await call("manage_trade_journal", { action: "list", environment: "demo", orderId: "1" })).structuredContent).toMatchObject({ total: 0 });
    expect((await call("manage_trade_journal", { action: "update", environment: "demo" })).isError).toBe(true);
    await call("manage_trade_journal", { action: "delete", environment: "demo", entryId: entry.id });
    expect((await call("manage_trade_journal", { action: "list", environment: "demo" })).structuredContent).toMatchObject({ total: 0, entries: [] });
    await client.close();
  });
});
