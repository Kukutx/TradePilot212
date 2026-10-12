// The day's move of each holding and of the account. Trading 212's Public API gives each holding's price now but
// neither its previous close nor the day's change, so the close comes from the quote provider's daily closes.

import type { TradingEnvironment } from "./contracts.js";
import type { PricePoint, PricesMissing } from "./prices.js";

/**
 * Why a holding has no move for the day: why its closes did not come (as on the holding page), its read ran out of
 * time ("later"), the closes end before the last session ("lag"), or no exchange rate to the account currency ("fx").
 */
export type DayMissing = PricesMissing | "later" | "lag" | "fx";

export interface DayMove {
  ticker: string;
  name?: string;
  shortName?: string;
  currencyCode?: string;
  /** Shares held now: 0 for an instrument sold out on the day. */
  quantity: number;
  /** Trading 212's price now, in the instrument's currency. */
  price?: number;
  /** The trading day the price is from (YYYY-MM-DD): the session in progress, else the last one. */
  day: string;
  /** The last close before that day, and who it is from. */
  previousClose?: PricePoint & { source: string };
  /** The price now against the previous close. */
  change?: number;
  /**
   * The day's profit or loss in the account currency, at today's exchange rate: the shares held at the previous close
   * from it, shares bought on the day from their fill price, and shares sold on the day to theirs.
   */
  profitLoss?: number;
  /** What the day's profit or loss is measured against: the shares held at the previous close at it, plus the day's buys. */
  base?: number;
  /** Shares bought and sold on the day. */
  bought?: number;
  sold?: number;
  missing?: DayMissing;
  problem?: string;
}

export interface PortfolioToday {
  kind: "portfolio_today";
  environment: TradingEnvironment;
  accountCurrency?: string;
  /** Holdings, then instruments sold out on the day, biggest move in the account currency first. */
  moves: DayMove[];
  /** The holdings with a move, added up; `change` is against their base. */
  total?: { profitLoss: number; change?: number; counted: number; of: number };
  /** Why the day's fills could not be read: shares traded on the day then count from the previous close. */
  fillsProblem?: string;
  /** Trading 212's value of the holdings now (the account summary's investments), when it reports it. */
  invested?: number;
  /** For each day whose sessions have all closed, when the last of them closed (ms). */
  ended?: Record<string, number>;
  timestamp: string;
}
