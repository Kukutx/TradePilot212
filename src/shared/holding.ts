// One instrument in one account: the position, its open orders, recent fills, dividends and alerts.

import type { PriceAlert } from "./automation.js";
import type { CredentialStatus, Instrument, PendingOrder, Position, TradingEnvironment } from "./contracts.js";
import type { MarketStatus } from "./history.js";
import type { JournalEntry } from "./journal.js";
import type { PriceHistory, PricesMissing } from "./prices.js";
import type { DayMove } from "./today.js";

/** One fill of an order on this instrument, newest first. */
export interface HoldingFill {
  /** The Trading 212 order the fill belongs to, so its journal note can be found. */
  orderId?: string;
  filledAt?: string;
  side?: string;
  type?: string;
  quantity?: number;
  price?: number;
  /** Currency of price (the instrument's quote currency). */
  priceCurrency?: string;
  /** What the fill moved in the account, in accountCurrency. */
  netValue?: number;
  accountCurrency?: string;
  realisedProfitLoss?: number;
}

/** One dividend paid on this instrument; the amount is in the account currency. */
export interface HoldingDividend {
  date: string;
  amount: number;
  currency: string;
  quantity?: number;
  grossPerShare?: number;
  perShareCurrency?: string;
}

export interface HoldingDetail {
  kind: "holding";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  ticker: string;
  instrument: Pick<Instrument, "ticker"> & Partial<Pick<Instrument, "name" | "shortName" | "currencyCode" | "type" | "isin">>;
  accountCurrency?: string;
  /** Absent when the instrument is not held. */
  position?: Position;
  /** On the watchlist since `addedAt`, with its note. */
  watching?: { addedAt: string; note?: string };
  /** The quote provider's price, when not held and it answered in time ("sample" for the sample account's). */
  quote?: { price: number; asOf: string; source: string; symbol: string };
  /** Share of total account value (0 to 1). */
  weight?: number;
  /** The saved target weight, when targets are saved and name this instrument. */
  targetWeight?: number;
  orders: PendingOrder[];
  alerts: PriceAlert[];
  /** Trade journal notes on this instrument, newest first: the newest ones and any on a listed fill. */
  journal: JournalEntry[];
  /** All notes on this instrument, when more than `journal` lists. */
  journalTotal?: number;
  market?: MarketStatus;
  /** The last 12 months of fills and dividends; absent when the history could not be read. */
  history?: {
    from: string;
    fills: HoldingFill[];
    /** Fills older than the 20 listed, up to 200 in all, with only what the price chart marks. */
    olderFills?: Array<{ filledAt: string; side: "BUY" | "SELL"; quantity: number; price: number }>;
    dividends: HoldingDividend[];
    /** Dividends received in the window, in the account currency, and how many payments; `dividends` lists the newest. */
    dividendTotal: number;
    dividendCount: number;
    /** The page budget ended before the window start, so older fills are missing. */
    fillsTruncated: boolean;
    /** The same for dividends; dividendTotal and dividendCount then cover only the newer part of the window. */
    dividendsTruncated: boolean;
  };
  /** Why the history is missing, e.g. Trading 212's rate limit; everything else is still current. */
  historyProblem?: string;
  /** The last 12 months of daily closes, in the instrument's unit, from the quote provider (or simulated for sample data). */
  prices?: PriceHistory;
  /** Why there are no daily closes, for the page to say in the viewer's language; `pricesProblem` says it in full. */
  pricesMissing?: PricesMissing;
  /** Why there are no daily closes: no quote provider, no symbol for the instrument, or the provider's answer. */
  pricesProblem?: string;
  /**
   * The day's move since the last close before the trading day of the price (as on the dashboard): for a holding,
   * what it made or lost in the account currency too. Absent without daily closes.
   */
  day?: DayMove;
  timestamp: string;
}
