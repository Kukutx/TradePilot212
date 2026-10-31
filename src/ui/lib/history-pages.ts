// A long history read a page at a time: the next page joined below the ones shown.

import type { JournalEntry } from "../../shared/journal";
import type { CashHistory, TradeHistory } from "../../shared/history";

type TradePages = TradeHistory & { journal?: JournalEntry[] };

/**
 * The pages shown and the next one as one list. It starts where the first did: a page the host showed may itself be a
 * later one. The window's count and totals are the newest read's; the orders that never filled come with the first
 * page, and a journal note on an order whose fills fall on both pages is kept once.
 */
export function joinPages<T extends TradePages | CashHistory>(current: T, next: T): T {
  const { offset: _offset, ...rest } = next;
  const start = current.offset ? { offset: current.offset } : {};
  if (current.kind === "trade_history" && rest.kind === "trade_history") {
    const shown = current as TradePages;
    const later = rest as unknown as TradePages;
    const seen = new Set((shown.journal ?? []).map((note) => note.id));
    const journal = [...(shown.journal ?? []), ...(later.journal ?? []).filter((note) => !seen.has(note.id))];
    const { unfilled: _unfilled, journal: _journal, ...page } = later;
    return { ...page, ...start, fills: [...shown.fills, ...later.fills], ...(shown.unfilled ? { unfilled: shown.unfilled } : {}), ...(journal.length ? { journal } : {}) } as T;
  }
  if (current.kind === "cash_history" && rest.kind === "cash_history") {
    return { ...rest, ...start, items: [...(current as CashHistory).items, ...(rest as unknown as CashHistory).items] } as T;
  }
  return current;
}
