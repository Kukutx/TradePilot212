import { describe, expect, it } from "vitest";
import type { CashHistory, TradeHistory } from "../../shared/history";
import type { JournalEntry } from "../../shared/journal";
import { joinPages } from "./history-pages";

const fill = (id: string) => ({ orderId: id, ticker: "AAPL_US_EQ", side: "BUY", filledAt: "2026-10-01T00:00:00Z" });
const note = (id: string, orderId: string) => ({ id, orderId, environment: "demo", ticker: "AAPL_US_EQ", createdAt: "2026-10-01T00:00:00Z" }) as unknown as JournalEntry;
const trades = (fills: string[], extra: Partial<TradeHistory & { journal: JournalEntry[] }> = {}) => ({
  kind: "trade_history", environment: "demo", period: { from: "2026-01-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" },
  fills: fills.map(fill), count: 9, limit: 2, totals: { buys: 9, sells: 0, bought: 900, sold: 0, realised: 0, costs: 0 }, truncated: false, timestamp: "t", ...extra,
}) as TradeHistory & { journal?: JournalEntry[] };

describe("a history read a page at a time", () => {
  it("lists the next page below the first, with the first page's unfilled orders and each note once", () => {
    const first = trades(["9", "8"], { unfilled: [{ orderId: "u" }] as TradeHistory["unfilled"], journal: [note("n8", "8")] });
    const next = trades(["8", "7"].slice(1), { offset: 2, journal: [note("n8", "8"), note("n7", "7")] });
    const joined = joinPages(first, next);
    expect(joined.fills.map((item) => item.orderId)).toEqual(["9", "8", "7"]);
    expect(joined).not.toHaveProperty("offset");
    expect(joined.unfilled).toEqual([{ orderId: "u" }]);
    expect(joined.journal!.map((item) => item.id)).toEqual(["n8", "n7"]);
  });

  it("starts where a later first page did, so the page after it is asked for from the right place", () => {
    const shown = trades(["7", "6"], { offset: 2 });
    const joined = joinPages(shown, trades(["5", "4"], { offset: 4 }));
    expect(joined.offset).toBe(2);
    // The next offset the widget asks for: the start plus everything listed.
    expect((joined.offset ?? 0) + joined.fills.length).toBe(6);
  });

  it("joins cash movements the same way", () => {
    const cash = (refs: string[], offset?: number) => ({ kind: "cash_history", environment: "demo", period: { to: "x" }, items: refs.map((reference) => ({ date: "2026-10-01", type: "DEPOSIT", amount: 1, currency: "EUR", reference })), count: 4, totals: {}, currency: "EUR", truncated: false, timestamp: "t", ...(offset ? { offset } : {}) }) as CashHistory;
    expect(joinPages(cash(["a", "b"]), cash(["c"], 2)).items.map((item) => item.reference)).toEqual(["a", "b", "c"]);
  });
});
