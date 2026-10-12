// The trade journal: why a trade was made, written when it was placed or later, and what you made of it
// looking back. Notes live in TradePilot's own store; Trading 212 never sees them.

import type { OrderSide, OrderType, TradingEnvironment } from "./contracts.js";

/** Longest thesis or review, in characters. */
export const MAX_JOURNAL_TEXT = 1000;
export const MAX_JOURNAL_TAGS = 8;
export const MAX_JOURNAL_TAG = 24;

export interface JournalEntry {
  id: string;
  environment: TradingEnvironment;
  ticker: string;
  /** The Trading 212 order the note is about, when known. */
  orderId?: string;
  /** The order as it was sent, when the note was written with it. `unconfirmed` means its result was unclear. */
  order?: { side: OrderSide; type: OrderType; quantity: number; unconfirmed?: true };
  /** Why the trade was made, in the user's words at the time. */
  thesis?: string;
  /** Looking back: what happened and what to keep or change. */
  review?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface JournalPayload {
  kind: "trade_journal";
  environment: TradingEnvironment;
  entries: JournalEntry[];
  /** Entries that matched, before `limit`. */
  total: number;
}

/** A trade at least this many days old, with a reason but no look back yet, is due for one. */
export const REVIEW_AFTER_DAYS = 30;

/** A note on a filled order, with how the trade has gone since. */
export interface JournalTrade {
  entry: JournalEntry;
  ticker: string;
  name?: string;
  side: "buy" | "sell";
  /** Shares filled, always positive. */
  quantity: number;
  /** The fill price, in the instrument's currency. */
  price: number;
  priceCurrency?: string;
  filledAt: string;
  /** Whole days since the fill. */
  days: number;
  /** The price now: the position's when held, else the quote provider's. Absent when neither has one. */
  priceNow?: number;
  /** The change from the fill price to now, as a fraction. FX and costs are left out. */
  move?: number;
  /** The move in the trade's favour: the change for a buy, its opposite for a sell. */
  edge?: number;
  /** What Trading 212 booked as realised on a sell, in the account currency. */
  realisedProfitLoss?: number;
  /** It has a reason, no look back yet, and the fill is at least REVIEW_AFTER_DAYS old. */
  due?: true;
}

/** How the trades of one tag (or all of them, or those without a tag) have gone. */
export interface JournalTagStats {
  /** Absent for all trades, and for the trades whose note has no tag (listed last, after the tags). */
  tag?: string;
  trades: number;
  /** Trades with a price now; the rest of the figures are worked out from these. */
  priced: number;
  /** Priced trades that have moved in the trade's favour. */
  inFavour: number;
  /** The mean edge of the priced trades, each counting once whatever its size. */
  averageEdge?: number;
  /** Realised P/L booked on the sells, in the account currency. */
  realisedProfitLoss: number;
}

export interface JournalReview {
  kind: "journal_review";
  environment: TradingEnvironment;
  /** The window the fills are from; no `from` is all time. */
  period: { from?: string; to: string };
  accountCurrency?: string;
  /** Set when only the notes with this tag were reviewed. */
  tag?: string;
  /** Fills in the window, and how many of them have a note. */
  fills: number;
  withNote: number;
  overall: JournalTagStats;
  tags: JournalTagStats[];
  /** Trades whose note has a look back, and trades due for one. */
  reviewed: number;
  due: number;
  /** Newest first, at most 50; `tradesTotal` counts them all. */
  trades: JournalTrade[];
  tradesTotal: number;
  /** Notes on orders that are not among the window's fills: still open, cancelled, or filled before it. */
  unmatched: number;
  /** Notes on an instrument rather than an order, and on orders whose result was unclear. */
  withoutOrder: number;
  /** Tickers with no price now; their trades count without an edge. */
  unpriced: string[];
  truncated: boolean;
  timestamp: string;
}

/** Cut to `max` characters without splitting one that takes two UTF-16 units. */
function cut(value: string, max: number): string {
  return value.length <= max ? value : Array.from(value).slice(0, max).join("");
}

/** Trimmed and cut to the longest a note keeps; empty is no text. */
export function journalText(value: string | undefined): string | undefined {
  const text = value === undefined ? "" : cut(value.trim(), MAX_JOURNAL_TEXT).trim();
  return text ? text : undefined;
}

/** Trimmed, without a leading '#', each kept once whatever its case, at most MAX_JOURNAL_TAGS. */
export function journalTags(values: string[] | undefined): string[] | undefined {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values ?? []) {
    const tag = cut(value.trim().replace(/^#+/, "").trim(), MAX_JOURNAL_TAG).trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === MAX_JOURNAL_TAGS) break;
  }
  return tags.length ? tags : undefined;
}
