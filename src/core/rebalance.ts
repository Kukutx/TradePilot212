// Pure rebalance planner: turns target weights into the smallest set of sells and buys that fits
// the cash on hand. It never places orders; the result becomes a basket the user reviews.

import type { AccountSummary, Position, TradingEnvironment } from "../shared/contracts.js";
import type { RebalanceNote, RebalancePlan, RebalanceTarget, RebalanceTrade } from "../shared/automation.js";
import { fail } from "./errors.js";
import { knownFxRates } from "./fx.js";
import type { ExternalFxRate } from "./quotes.js";

export interface RebalanceOptions {
  /** Share of total value to keep as cash after rebalancing (0 to 1). */
  cashWeight?: number;
  /** Skip trades smaller than this, in the account currency. */
  minTradeValue?: number;
  /** Sell holdings that have no target down to zero. Ignored with buyOnly. */
  sellUntargeted?: boolean;
  /** Sell nothing: invest only the cash above the reserve, in the targets below their weight. */
  buyOnly?: boolean;
  /** With buyOnly, invest at most this much, in the account currency. */
  investAmount?: number;
  /** Decimal places allowed for quantities; 0 means whole shares only. */
  quantityDecimals?: number;
  /** Instrument-currency units per 1 account-currency unit, keyed by currency code. */
  fxRates?: Record<string, number>;
  /** Rates from the quote provider for currencies no holding is priced in; holdings and fxRates win. */
  quotedFxRates?: Record<string, ExternalFxRate>;
}

const floorTo = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.floor(value * factor + 1e-9) / factor;
};
const money = (value: number) => Math.round(value * 100) / 100;
const share = (value: number) => Math.round(value * 10_000) / 10_000;

interface Line {
  ticker: string;
  currency: string;
  price: number;
  fx: number;
  heldQuantity: number;
  sellable: number;
  currentValue: number;
  targetWeight: number;
  /** When the price is from; undefined for a caller-supplied price without a timestamp. */
  priceAt?: string;
}

export { impliedFxRates } from "./fx.js";

export function planRebalance(
  environment: TradingEnvironment,
  account: AccountSummary,
  positions: Position[],
  targets: RebalanceTarget[],
  options: RebalanceOptions = {},
  instrumentCurrency: (ticker: string) => string | undefined = () => undefined,
): RebalancePlan {
  const accountCurrency = (account.currency ?? "").toUpperCase();
  const totalValue = account.totalValue ?? 0;
  const cashBefore = account.cash?.availableToTrade ?? 0;
  if (!accountCurrency || totalValue <= 0) fail("INVALID_INPUT", "The account value is unavailable, so a rebalance cannot be computed");

  const cashWeight = options.cashWeight ?? 0;
  const buyOnly = !!options.buyOnly || options.investAmount !== undefined;
  if (options.investAmount !== undefined && !(options.investAmount > 0)) fail("INVALID_INPUT", "investAmount must be a positive amount in the account currency", { field: "investAmount" });
  const minTradeValue = options.minTradeValue ?? 1;
  const decimals = options.quantityDecimals ?? 4;
  const targetSum = targets.reduce((sum, target) => sum + target.weight, 0);
  if (targets.some((target) => target.weight < 0 || target.weight > 1)) fail("INVALID_INPUT", "Each target weight must be between 0 and 1");
  if (targetSum + cashWeight > 1 + 1e-9) fail("INVALID_INPUT", `Target weights (${(targetSum * 100).toFixed(1)}%) plus cash (${(cashWeight * 100).toFixed(1)}%) exceed 100%`);
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.ticker.toUpperCase();
    if (seen.has(key)) fail("INVALID_INPUT", `${target.ticker} appears more than once in the targets`);
    seen.add(key);
  }

  const notes: string[] = [];
  const noteDetails: RebalanceNote[] = [];
  const note = (code: RebalanceNote["code"], message: string, details?: RebalanceNote["details"]) => {
    notes.push(message);
    noteDetails.push({ code, message, ...(details ? { details } : {}) });
  };
  const skipped: RebalancePlan["skipped"] = [];
  const byTicker = new Map(positions.map((position) => [position.instrument.ticker.toUpperCase(), position]));
  const wanted = new Map(targets.map((target) => [target.ticker.toUpperCase(), target]));
  if (options.sellUntargeted && !buyOnly) {
    for (const position of positions) {
      const key = position.instrument.ticker.toUpperCase();
      if (!wanted.has(key) && position.quantity > 0) wanted.set(key, { ticker: position.instrument.ticker, weight: 0 });
    }
  } else {
    const untouched = positions.filter((position) => !wanted.has(position.instrument.ticker.toUpperCase()) && position.quantity > 0);
    if (untouched.length) note("untargeted_kept", `${untouched.length} holding(s) without a target are left as they are.`, { count: untouched.length });
  }

  // Rates you pass win; then the broker's valuation of your holdings; then the quote provider.
  const implied = knownFxRates(positions, accountCurrency);
  const quotedRates = Object.fromEntries(Object.entries(options.quotedFxRates ?? {}).filter(([code]) => !implied[code]).map(([code, rate]) => [code, rate.rate]));
  const fxRates: Record<string, number> = { ...quotedRates, ...implied, ...options.fxRates };
  const usedImplied = new Set<string>();
  const usedQuoted = new Set<string>();
  const lines: Line[] = [];
  for (const [key, target] of wanted) {
    const position = byTicker.get(key);
    const currency = (position?.instrument.currencyCode || instrumentCurrency(target.ticker) || accountCurrency).toUpperCase();
    const fx = currency === accountCurrency ? 1 : fxRates[currency];
    if (currency !== accountCurrency && fx && !options.fxRates?.[currency]) (implied[currency] ? usedImplied : usedQuoted).add(currency);
    const price = position?.currentPrice && position.currentPrice > 0 ? position.currentPrice : target.referencePrice;
    if (!fx || fx <= 0) {
      skipped.push({ ticker: target.ticker, code: "no_fx_rate", currency, reason: `Quoted in ${currency} and no holding in ${currency} gives an exchange rate and the quote source has none; pass fxRates.${currency} (units per 1 ${accountCurrency}) to include it.` });
      continue;
    }
    if (!price || price <= 0) {
      skipped.push({ ticker: target.ticker, code: "no_price", reason: "No price: it is not held and the quote source has none for it, so pass referencePrice." });
      continue;
    }
    const heldQuantity = Math.max(0, position?.quantity ?? 0);
    const brokerPrice = !!(position?.currentPrice && position.currentPrice > 0);
    const priceAt = brokerPrice ? new Date().toISOString() : target.referencePriceAt;
    lines.push({
      ...(priceAt ? { priceAt } : {}),
      ticker: position?.instrument.ticker ?? target.ticker,
      currency,
      price,
      fx,
      heldQuantity,
      sellable: Math.max(0, position?.quantityAvailableForTrading ?? 0),
      currentValue: heldQuantity * price / fx,
      targetWeight: target.weight,
    });
  }

  const trades: RebalanceTrade[] = [];
  const valueAfter = new Map(lines.map((line) => [line.ticker, line.currentValue]));
  let cash = cashBefore;

  // Sells first: they fund the buys.
  for (const line of buyOnly ? [] : lines) {
    const excess = line.currentValue - line.targetWeight * totalValue;
    if (excess < minTradeValue) continue;
    const wantedQuantity = line.targetWeight === 0 ? line.heldQuantity : floorTo(excess * line.fx / line.price, decimals);
    const quantity = Math.min(wantedQuantity, line.sellable);
    if (quantity < wantedQuantity) note("sell_limited", `${line.ticker}: only ${line.sellable} share(s) are tradable, so the sell is smaller than the target needs.`, { ticker: line.ticker, sellable: line.sellable });
    const value = quantity * line.price / line.fx;
    if (quantity <= 0 || value < minTradeValue) continue;
    cash += value;
    valueAfter.set(line.ticker, line.currentValue - value);
    trades.push({ ticker: line.ticker, side: "sell", quantity, price: line.price, currency: line.currency, ...(line.priceAt ? { priceAt: line.priceAt } : {}), value: money(value), currentWeight: share(line.currentValue / totalValue), targetWeight: line.targetWeight, resultingWeight: 0 });
  }

  // Buys share whatever cash is left above the reserve, in proportion to their shortfall.
  const reserve = cashWeight * totalValue;
  const shortfalls = lines
    .map((line) => ({ line, gap: line.targetWeight * totalValue - line.currentValue }))
    .filter((item) => item.gap >= minTradeValue);
  const wantedCash = shortfalls.reduce((sum, item) => sum + item.gap, 0);
  const available = Math.max(0, cash - reserve);
  const budget = options.investAmount === undefined ? available : Math.min(options.investAmount, available);
  if (buyOnly) note("buy_only", `Nothing is sold: up to ${money(budget)} ${accountCurrency} of the cash above the reserve goes to the targets below their weight, most to the furthest below.`, { budget: money(budget), currency: accountCurrency });
  if (options.investAmount !== undefined && options.investAmount > available + 0.005) note("amount_capped", `Only ${money(available)} ${accountCurrency} is available above the cash reserve, less than the ${money(options.investAmount)} ${accountCurrency} asked for.`, { amount: money(options.investAmount), available: money(available), currency: accountCurrency });
  const scale = wantedCash > 0 ? Math.min(1, budget / wantedCash) : 0;
  // In buy-only mode the buy_only note already gives the amount being invested.
  if (!buyOnly && wantedCash > 0 && scale < 1) note("buys_scaled", `Buys are scaled to ${(scale * 100).toFixed(0)}% because only ${money(budget)} ${accountCurrency} is available above the cash reserve.`, { scale: share(scale), budget: money(budget), currency: accountCurrency });
  for (const { line, gap } of shortfalls) {
    const quantity = floorTo(gap * scale * line.fx / line.price, decimals);
    const value = quantity * line.price / line.fx;
    if (quantity <= 0 || value < minTradeValue) {
      if (scale > 0) skipped.push(decimals === 0 ? { ticker: line.ticker, code: "below_one_share", reason: "The buy is smaller than one whole share." } : { ticker: line.ticker, code: "below_minimum", reason: "The buy is below the minimum trade value." });
      continue;
    }
    cash -= value;
    valueAfter.set(line.ticker, line.currentValue + value);
    trades.push({ ticker: line.ticker, side: "buy", quantity, price: line.price, currency: line.currency, ...(line.priceAt ? { priceAt: line.priceAt } : {}), value: money(value), currentWeight: share(line.currentValue / totalValue), targetWeight: line.targetWeight, resultingWeight: 0 });
  }

  for (const trade of trades) trade.resultingWeight = share((valueAfter.get(trade.ticker) ?? 0) / totalValue);
  if (usedImplied.size) note("implied_rates", `Exchange rates for ${[...usedImplied].sort().join(", ")} come from the broker's valuation of your holdings.`, { currencies: [...usedImplied].sort().join(", ") });
  if (usedQuoted.size) {
    const sources = [...usedQuoted].sort().map((code) => options.quotedFxRates?.[code]).filter((rate): rate is ExternalFxRate => !!rate);
    const currencies = sources.map((rate) => rate.to).join(", ");
    const source = sources[0]?.source ?? "";
    const asOf = sources.map((rate) => rate.asOf).sort()[0] ?? "";
    note("quoted_rates", `Exchange rates for ${currencies} come from ${source} (as of ${asOf}); Trading 212 converts at its own rate and fee.`, { currencies, source, asOf });
  }
  if (!trades.length) {
    if (skipped.length && !lines.length) note("nothing_possible", "No trades could be planned: every target was skipped.");
    else if (wantedCash > 0 && scale === 0) note("no_cash", `Some targets are below their weight, but no cash is available above the reserve to buy with${buyOnly ? " and nothing is sold" : ""}.`);
    else note("within_threshold", "The portfolio is already within the minimum trade value of every target.");
  }
  note("price_source", "Prices are the broker's last position prices, quotes from the quote source, or the reference prices you supplied; Market orders can fill elsewhere.");

  return {
    kind: "rebalance_plan",
    environment,
    accountCurrency,
    totalValue: money(totalValue),
    cashBefore: money(cashBefore),
    cashAfter: money(cash),
    ...(buyOnly ? { buyOnly: true } : {}),
    trades,
    skipped,
    notes,
    noteDetails,
  };
}
