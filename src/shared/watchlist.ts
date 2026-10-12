// The watchlist: instruments you follow, held or not, each with its price now, how it moved, where it sits in its
// year's range, and the open orders and armed alerts waiting on it. TradePilot keeps it, per account; Trading 212's
// Public API has no watchlists.

import type { CredentialStatus, TradingEnvironment } from "./contracts.js";
import type { PricesMissing } from "./prices.js";

/** Instruments one account's watchlist keeps. */
export const MAX_WATCHLIST = 50;
/** The longest a watchlist note keeps. */
export const MAX_WATCH_NOTE = 200;

/** The periods a row gives the change over: since the last close before today, and over 1, 3 and 12 months. */
export const WATCH_PERIODS = ["1d", "1m", "3m", "1y"] as const;
export type WatchPeriod = typeof WATCH_PERIODS[number];

export interface WatchItem {
  environment: TradingEnvironment;
  ticker: string;
  note?: string;
  addedAt: string;
  /** The price when it was added, when one was known, for "since added". */
  addedPrice?: number;
}

/** An open order or an armed above/below alert on the instrument, and how far the price is from it. */
export interface WatchLevel {
  kind: "alert" | "limit" | "stop";
  /** An order's side. */
  side?: "buy" | "sell";
  /** An alert's condition. */
  condition?: "above" | "below";
  price: number;
  /** From the price now to the level, as a fraction: 0.05 is 5% above it. */
  distance?: number;
}

export interface WatchRow {
  ticker: string;
  name?: string;
  shortName?: string;
  currencyCode?: string;
  type?: string;
  note?: string;
  addedAt: string;
  addedPrice?: number;
  /** The position, when the instrument is held. */
  held?: { quantity: number; averagePrice: number };
  /** The price now, in the instrument's unit. */
  price?: number;
  /** "broker" for Trading 212's price of a holding, "close" for the last daily close, else the quote provider. */
  priceSource?: string;
  priceAt?: string;
  /** From the price when added to the price now. */
  sinceAdded?: number;
  /** The change to the price now over each period the closes cover in full (1d: since the last close before today). */
  changes: Partial<Record<WatchPeriod, number>>;
  /** The highest and lowest of the closes (up to a year) and the price now. */
  high?: number;
  low?: number;
  /** The closes of the last three months, oldest first, ending at the price now; `from` is the first one's date. */
  spark?: { from: string; closes: number[] };
  /** Open orders and armed alerts, nearest the price first. */
  levels: WatchLevel[];
  /** Why there are no closes ("later": past this read's time, asked on the next). */
  pricesMissing?: PricesMissing | "later";
  pricesProblem?: string;
}

export interface WatchlistView {
  kind: "watchlist";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  accountCurrency?: string;
  items: WatchRow[];
  timestamp: string;
}
