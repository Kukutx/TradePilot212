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
