// The instruments Trading 212 added in a window, from its instrument list: newest first, with how many of each type
// were added, so a choice of type shows what it would leave.

import type { Instrument } from "../shared/contracts.js";
import { MAX_LISTING_DAYS, MAX_LISTINGS, type NewListing } from "../shared/listings.js";

export interface ListingQuery {
  days: number;
  type?: string;
  currency?: string;
  limit?: number;
}

export interface ListingResult {
  from: string;
  listings: NewListing[];
  total: number;
  types: Record<string, number>;
  catalogue: number;
  undated: number;
}

const DAY_MS = 86_400_000;
/** A date a little ahead of now still counts: Trading 212's clock and this one need not agree to the minute. */
const AHEAD_MS = DAY_MS;

export function newListings(instruments: Instrument[], query: ListingQuery, now = new Date()): ListingResult {
  const days = Math.min(MAX_LISTING_DAYS, Math.max(1, Math.round(query.days)));
  const limit = Math.min(MAX_LISTINGS, Math.max(1, Math.round(query.limit ?? 50)));
  const start = now.getTime() - days * DAY_MS;
  const type = query.type?.trim().toUpperCase();
  const currency = query.currency?.trim().toUpperCase();
  let undated = 0;
  const types: Record<string, number> = {};
  const matched: Array<{ item: Instrument; at: number }> = [];
  for (const item of instruments) {
    const at = item.addedOn ? Date.parse(item.addedOn) : Number.NaN;
    if (!Number.isFinite(at)) { undated += 1; continue; }
    if (at < start || at > now.getTime() + AHEAD_MS) continue;
    if (currency && item.currencyCode?.toUpperCase() !== currency) continue;
    const kind = item.type?.toUpperCase() || "OTHER";
    types[kind] = (types[kind] ?? 0) + 1;
    if (type && kind !== type) continue;
    matched.push({ item, at });
  }
  matched.sort((a, b) => b.at - a.at || (a.item.name ?? "").localeCompare(b.item.name ?? "") || a.item.ticker.localeCompare(b.item.ticker));
  return {
    from: new Date(start).toISOString(),
    listings: matched.slice(0, limit).map(({ item }) => ({
      ticker: item.ticker,
      name: item.name || item.shortName || item.ticker,
      ...(item.shortName ? { shortName: item.shortName } : {}),
      currencyCode: item.currencyCode,
      ...(item.type ? { type: item.type } : {}),
      ...(item.isin ? { isin: item.isin } : {}),
      addedOn: item.addedOn!,
      ...(item.extendedHours ? { extendedHours: true } : {}),
    })),
    total: matched.length,
    types,
    catalogue: instruments.length,
    undated,
  };
}
