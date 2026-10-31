// Instruments Trading 212 added recently: its instrument list dates each one (addedOn), so the newest are those added
// in the last days. Read-only; reading it costs one instrument-list read, which TradePilot keeps for ten minutes.

import type { CredentialStatus, TradingEnvironment } from "./contracts.js";

/** The windows the watchlist's panel offers, in days. */
export const LISTING_WINDOWS = [7, 30, 90] as const;
/** The longest window a read may ask for, in days. */
export const MAX_LISTING_DAYS = 365;
/** The most listings one read returns. */
export const MAX_LISTINGS = 100;

export interface NewListing {
  ticker: string;
  name: string;
  shortName?: string;
  currencyCode: string;
  type?: string;
  isin?: string;
  /** When Trading 212 added it. */
  addedOn: string;
  extendedHours?: boolean;
}

export interface NewListingsView {
  kind: "new_listings";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  days: number;
  /** The start of the window; it ends at `timestamp`. */
  from: string;
  /** The type and currency asked for, as Trading 212 writes them. */
  type?: string;
  currency?: string;
  /** Added in the window and matching, newest first, up to the limit. */
  listings: NewListing[];
  /** How many match before the limit. */
  total: number;
  /** Instruments added in the window of each type, before the type is chosen: what the type choice offers. */
  types: Record<string, number>;
  /** Instruments in the list, and those of them with no date Trading 212 gives (never counted as new). */
  catalogue: number;
  undated: number;
  timestamp: string;
}
