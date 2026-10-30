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
  let fx = 0;
  if (finite(wallet?.fxImpact)) fx = wallet.fxImpact;
  else {
    const account = major(wallet?.currency);
    if (!account || account !== major(position.instrument?.currencyCode)) return undefined;
  }
  return { total, price: round(total - fx), fx };
}

/**
 * The holdings' split added up, over the holdings with an unrealized P/L; absent when any of them has no split, as a
 * part would then be missing. `foreign` counts the holdings whose exchange rate moved their result.
 */
export function resultSplitOf(positions: Position[]): (ResultSplit & { foreign: number }) | undefined {
  let total = 0, fx = 0, foreign = 0, any = false;
  for (const position of positions) {
    if (!finite(position.walletImpact?.unrealizedProfitLoss)) continue;
    const split = resultSplit(position);
    if (!split) return undefined;
    any = true;
    total += split.total;
    fx += split.fx;
    if (split.fx !== 0) foreign++;
  }
  return any ? { total: round(total), price: round(total - fx), fx: round(fx), foreign } : undefined;
}
