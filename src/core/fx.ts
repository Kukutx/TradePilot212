// Exchange rates TradePilot can know without a market-data feed: the broker's own valuation of each
// holding, and the fixed ratio between pence (GBX) and pounds (GBP).
// A rate is instrument-currency units per 1 account-currency unit, e.g. { USD: 1.08 } for a EUR account.

import type { Position } from "../shared/contracts.js";

export type FxRates = Record<string, number>;

/**
 * Rates implied by the broker's valuation of each holding (its price and quantity against its value in
 * the account currency). Holdings in the same currency give the same rate, so the median is used.
 */
export function impliedFxRates(positions: Position[], accountCurrency: string): FxRates {
  const account = accountCurrency.toUpperCase();
  const samples = new Map<string, number[]>();
  for (const position of positions) {
    const instrument = position.instrument as { currencyCode?: string; currency?: string } | undefined;
    const currency = (instrument?.currencyCode ?? instrument?.currency)?.toUpperCase();
    const wallet = position.walletImpact as { currentValue?: unknown; currency?: unknown } | undefined;
    if (!currency || currency === account) continue;
    if (typeof wallet?.currency === "string" && wallet.currency.toUpperCase() !== account) continue;
    const value = typeof wallet?.currentValue === "number" ? wallet.currentValue : 0;
    const local = position.quantity * position.currentPrice;
    if (!(value > 0) || !(local > 0)) continue;
    samples.set(currency, [...(samples.get(currency) ?? []), local / value]);
  }
  const rates: FxRates = {};
  for (const [currency, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    rates[currency] = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return rates;
}

/** Implied rates plus the account currency itself and the pence/pound ratio in whichever direction is missing. */
export function knownFxRates(positions: Position[], accountCurrency: string): FxRates {
  const account = accountCurrency.toUpperCase();
  if (!account) return {};
  const rates: FxRates = { ...impliedFxRates(positions, account), [account]: 1 };
  if (rates.GBP && !rates.GBX) rates.GBX = rates.GBP * 100;
  if (rates.GBX && !rates.GBP) rates.GBP = rates.GBX / 100;
  return rates;
}

/** Units of `to` per 1 unit of `from`, when both currencies have a known rate. */
export function crossRate(rates: FxRates, from: string, to: string): number | undefined {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  if (source === target) return 1;
  if (source === "GBP" && target === "GBX") return 100;
  if (source === "GBX" && target === "GBP") return 0.01;
  const a = rates[source];
  const b = rates[target];
  return a && b ? b / a : undefined;
}

/** `amount` in `currency`, expressed in the account currency; undefined when no rate is known. */
export function toAccountCurrency(amount: number, currency: string, accountCurrency: string, rates: FxRates): number | undefined {
  if (!accountCurrency) return undefined;
  const rate = crossRate(rates, accountCurrency, currency);
  return rate ? amount / rate : undefined;
}
