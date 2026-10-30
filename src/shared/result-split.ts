// A holding's unrealized result in the account currency, split into what the price did and what the exchange rate did.

import type { Position } from "./contracts.js";

export interface ResultSplit {
  /** Trading 212's unrealized P/L. */
  total: number;
  /** What the instrument's price did, at today's exchange rate: total less fx. */
  price: number;
  /**
   * What the exchange rate did since the shares were bought (Trading 212's fxImpact); zero for an instrument
   * quoted in the account's currency.
   */
  fx: number;
  /** Whether the instrument is quoted in another currency than the account's (or, without the account's, has a rate part). */
  foreign: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number) => Math.round(value * 100) / 100;
/** Pence are pounds: a GBX instrument in a GBP account has no exchange rate. */
const major = (currency: unknown) => (typeof currency === "string" && currency ? (currency.toUpperCase() === "GBX" ? "GBP" : currency.toUpperCase()) : undefined);

/**
 * The split, when Trading 212 gives the unrealized P/L and either its fxImpact or a wallet currency the instrument is
 * quoted in (no exchange rate, so no exchange-rate part). Absent otherwise: a missing fxImpact on a foreign holding
 * is not known to be zero.
 */
export function resultSplit(position: Position): ResultSplit | undefined {
  const wallet = position.walletImpact;
  const total = wallet?.unrealizedProfitLoss;
  if (!finite(total)) return undefined;
  const account = major(wallet?.currency);
  const quote = major(position.instrument?.currencyCode);
  let fx = 0;
  if (finite(wallet?.fxImpact)) fx = wallet.fxImpact;
  else if (!account || account !== quote) return undefined;
  return { total, price: round(total - fx), fx, foreign: account && quote ? account !== quote : fx !== 0 };
}

/**
 * The holdings' split added up; absent when any holding has no split (or no unrealized P/L), as the account's
 * result would then hold a part that is not counted. `foreign` counts the holdings in another currency.
 */
export function resultSplitOf(positions: Position[]): (Omit<ResultSplit, "foreign"> & { foreign: number }) | undefined {
  let total = 0, fx = 0, foreign = 0;
  for (const position of positions) {
    const split = resultSplit(position);
    if (!split) return undefined;
    total += split.total;
    fx += split.fx;
    if (split.foreign) foreign++;
  }
  return positions.length ? { total: round(total), price: round(total - fx), fx: round(fx), foreign } : undefined;
}

/** Whether an exchange-rate part is worth naming: at least a cent either way. */
export const fxShown = (fx: number | undefined): fx is number => fx !== undefined && Math.abs(fx) >= 0.005;
