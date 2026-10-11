// Pure rebalance planner: turns target weights into the smallest set of sells and buys that fits
// the cash on hand. It never places orders; the result becomes a basket the user reviews.

import type { AccountSummary, Position, TradingEnvironment } from "../shared/contracts.js";
import type { RebalancePlan, RebalanceTarget, RebalanceTrade } from "../shared/automation.js";
import { fail } from "./errors.js";

export interface RebalanceOptions {
  /** Share of total value to keep as cash after rebalancing (0 to 1). */
  cashWeight?: number;
  /** Skip trades smaller than this, in the account currency. */
  minTradeValue?: number;
  /** Sell holdings that have no target down to zero. */
  sellUntargeted?: boolean;
  /** Decimal places allowed for quantities; 0 means whole shares only. */
  quantityDecimals?: number;
  /** Instrument-currency units per 1 account-currency unit, keyed by currency code. */
  fxRates?: Record<string, number>;
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
}

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
  const skipped: RebalancePlan["skipped"] = [];
  const byTicker = new Map(positions.map((position) => [position.instrument.ticker.toUpperCase(), position]));
  const wanted = new Map(targets.map((target) => [target.ticker.toUpperCase(), target]));
  if (options.sellUntargeted) {
    for (const position of positions) {
      const key = position.instrument.ticker.toUpperCase();
      if (!wanted.has(key) && position.quantity > 0) wanted.set(key, { ticker: position.instrument.ticker, weight: 0 });
    }
  } else {
    const untouched = positions.filter((position) => !wanted.has(position.instrument.ticker.toUpperCase()) && position.quantity > 0);
    if (untouched.length) notes.push(`${untouched.length} holding(s) without a target are left as they are.`);
  }

  const lines: Line[] = [];
  for (const [key, target] of wanted) {
    const position = byTicker.get(key);
    const currency = (position?.instrument.currencyCode ?? instrumentCurrency(target.ticker) ?? accountCurrency).toUpperCase();
    const fx = currency === accountCurrency ? 1 : options.fxRates?.[currency];
    const price = position?.currentPrice && position.currentPrice > 0 ? position.currentPrice : target.referencePrice;
    if (!fx || fx <= 0) {
      skipped.push({ ticker: target.ticker, reason: `Quoted in ${currency}; pass fxRates.${currency} (units per 1 ${accountCurrency}) to include it.` });
      continue;
    }
    if (!price || price <= 0) {
      skipped.push({ ticker: target.ticker, reason: "No price: Trading 212 only reports prices for held instruments, so pass referencePrice." });
      continue;
    }
    const heldQuantity = Math.max(0, position?.quantity ?? 0);
    lines.push({
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
  for (const line of lines) {
    const excess = line.currentValue - line.targetWeight * totalValue;
    if (excess < minTradeValue) continue;
    const wantedQuantity = line.targetWeight === 0 ? line.heldQuantity : floorTo(excess * line.fx / line.price, decimals);
    const quantity = Math.min(wantedQuantity, line.sellable);
    if (quantity < wantedQuantity) notes.push(`${line.ticker}: only ${line.sellable} share(s) are tradable, so the sell is smaller than the target needs.`);
    const value = quantity * line.price / line.fx;
    if (quantity <= 0 || value < minTradeValue) continue;
    cash += value;
    valueAfter.set(line.ticker, line.currentValue - value);
    trades.push({ ticker: line.ticker, side: "sell", quantity, price: line.price, value: money(value), currentWeight: share(line.currentValue / totalValue), targetWeight: line.targetWeight, resultingWeight: 0 });
  }

  // Buys share whatever cash is left above the reserve, in proportion to their shortfall.
  const reserve = cashWeight * totalValue;
  const shortfalls = lines
    .map((line) => ({ line, gap: line.targetWeight * totalValue - line.currentValue }))
    .filter((item) => item.gap >= minTradeValue);
  const wantedCash = shortfalls.reduce((sum, item) => sum + item.gap, 0);
  const budget = Math.max(0, cash - reserve);
  const scale = wantedCash > 0 ? Math.min(1, budget / wantedCash) : 0;
  if (wantedCash > 0 && scale < 1) notes.push(`Buys are scaled to ${(scale * 100).toFixed(0)}% because only ${money(budget)} ${accountCurrency} is available above the cash reserve.`);
  for (const { line, gap } of shortfalls) {
    const quantity = floorTo(gap * scale * line.fx / line.price, decimals);
    const value = quantity * line.price / line.fx;
    if (quantity <= 0 || value < minTradeValue) {
      if (scale > 0) skipped.push({ ticker: line.ticker, reason: decimals === 0 ? "The buy is smaller than one whole share." : "The buy is below the minimum trade value." });
      continue;
    }
    cash -= value;
    valueAfter.set(line.ticker, line.currentValue + value);
    trades.push({ ticker: line.ticker, side: "buy", quantity, price: line.price, value: money(value), currentWeight: share(line.currentValue / totalValue), targetWeight: line.targetWeight, resultingWeight: 0 });
  }

  for (const trade of trades) trade.resultingWeight = share((valueAfter.get(trade.ticker) ?? 0) / totalValue);
  if (!trades.length) notes.push("The portfolio is already within the minimum trade value of every target.");
  notes.push("Prices are the broker's last position prices or the reference prices you supplied; Market orders can fill elsewhere.");

  return {
    kind: "rebalance_plan",
    environment,
    accountCurrency,
    totalValue: money(totalValue),
    cashBefore: money(cashBefore),
    cashAfter: money(cash),
    trades,
    skipped,
    notes,
  };
}
