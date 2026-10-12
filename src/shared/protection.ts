// How much of each holding a pending sell stop would sell if the price falls.

import type { PendingOrder, Position } from "./contracts.js";

export interface StopProtection {
  ticker: string;
  /** The highest stop among the holding's sell stops: the first to trigger on a fall. */
  stopPrice: number;
  /** That stop against the last price as a fraction, negative below it (-0.083 = 8.3% below); absent without a last price. */
  gap?: number;
  /** Shares the pending sell stops would sell, capped at the holding. */
  covered: number;
  /** covered as a share of the holding (0 to 1). */
  coverage: number;
  orders: number;
  /**
   * The covered shares by stop price, highest first: a fall reaches the higher stops first, so when the
   * stops add up to more than the holding, the lowest go without. The quantities add up to covered.
   */
  levels: StopLevel[];
  /** Stops placed by amount (VALUE) with no share count, so their shares and outcome are unknown. */
  unsized?: number;
}

export interface StopLevel {
  stopPrice: number;
  quantity: number;
  /** A stop-limit's limit: once triggered it sells at this price or better, or not at all. */
  limitPrice?: number;
}

export interface StopOutcome {
  /** What the covered shares would lose falling from the last price to the stop, in the account currency. */
  drop: number;
  /** Their unrealized P/L once at the stop, in the account currency; absent without the broker's P/L. */
  pnlAtStop?: number;
}

/**
 * What the stops mean once the price has fallen through every one, each selling its shares at its own
 * price, converted at the rate the broker's valuation of the holding implies. A stop-limit is costed at
 * its limit: once triggered it becomes a Limit order that fills there or better. Undefined without that
 * valuation, or when a stop or limit is not below the last price (the stop would trigger at once, or the
 * limit sells above the price). A gap can fill a stop lower, or leave a stop-limit unfilled, so this is
 * what the stops promise rather than what a fall guarantees.
 */
export function stopOutcome(position: Position, guard: StopProtection): StopOutcome | undefined {
  const wallet = position.walletImpact as { currentValue?: unknown; unrealizedProfitLoss?: unknown } | undefined;
  const value = typeof wallet?.currentValue === "number" && Number.isFinite(wallet.currentValue) ? wallet.currentValue : undefined;
  const sale = (level: StopLevel) => level.limitPrice ?? level.stopPrice;
  if (!value || !(position.quantity > 0) || !(guard.stopPrice < position.currentPrice)) return undefined;
  // A stop sized by amount sells shares we cannot count, so any figure would leave it out.
  if (guard.unsized || !guard.levels.length) return undefined;
  if (guard.levels.some((level) => !(sale(level) < position.currentPrice))) return undefined;
  const rate = value / (position.quantity * position.currentPrice);
  const drop = guard.levels.reduce((sum, level) => sum + (position.currentPrice - sale(level)) * level.quantity, 0) * rate;
  const pnl = typeof wallet?.unrealizedProfitLoss === "number" && Number.isFinite(wallet.unrealizedProfitLoss) ? wallet.unrealizedProfitLoss : undefined;
  return { drop, ...(pnl === undefined ? {} : { pnlAtStop: pnl * guard.coverage - drop }) };
}

/** A stop or stop-limit that sells: the orders that protect a holding against a fall. */
export function isSellStop(order: PendingOrder): boolean {
  if (typeof order.stopPrice !== "number" || !(order.stopPrice > 0)) return false;
  return String(order.side ?? "").toUpperCase() === "SELL" || (typeof order.quantity === "number" && order.quantity < 0);
}

export function stopProtection(position: Position, orders: PendingOrder[]): StopProtection | undefined {
  const ticker = position.instrument.ticker;
  const stops = orders.filter((order) => order.ticker === ticker && isSellStop(order));
  if (!stops.length || !(position.quantity > 0)) return undefined;
  // Part of a stop may already have filled; only the rest is still waiting.
  const remaining = (order: PendingOrder) => Math.max(0, Math.abs(order.quantity ?? 0) - Math.abs(order.filledQuantity ?? 0));
  // Trading 212 quantities have at most 8 decimals; rounding the sum keeps 0.1 + 0.7 equal to 0.8.
  const covered = Math.min(position.quantity, Number(stops.reduce((sum, order) => sum + remaining(order), 0).toFixed(8)));
  const stopPrice = Math.max(...stops.map((order) => order.stopPrice as number));
  // One level per stop and limit; the highest stops trigger first, and of two at one stop the plain stop sorts first.
  const byPrice = new Map<string, StopLevel>();
  for (const order of stops) {
    const limit = typeof order.limitPrice === "number" && order.limitPrice > 0 ? order.limitPrice : undefined;
    const key = `${order.stopPrice}|${limit ?? ""}`;
    const level = byPrice.get(key) ?? { stopPrice: order.stopPrice as number, quantity: 0, ...(limit === undefined ? {} : { limitPrice: limit }) };
    byPrice.set(key, { ...level, quantity: level.quantity + remaining(order) });
  }
  const levels: StopLevel[] = [];
  let left = covered;
  for (const level of [...byPrice.values()].sort((a, b) => b.stopPrice - a.stopPrice || (b.limitPrice ?? Infinity) - (a.limitPrice ?? Infinity))) {
    const take = Number(Math.min(level.quantity, left).toFixed(8));
    if (take > 0) levels.push({ ...level, quantity: take });
    left = Number((left - take).toFixed(8));
  }
  const unsized = stops.filter((order) => String(order.strategy ?? "").toUpperCase() === "VALUE" || typeof order.quantity !== "number" || order.quantity === 0).length;
  const last = position.currentPrice;
  return {
    ticker,
    stopPrice,
    ...(last > 0 ? { gap: (stopPrice - last) / last } : {}),
    covered,
    coverage: covered >= position.quantity ? 1 : covered / position.quantity,
    orders: stops.length,
    levels,
    ...(unsized ? { unsized } : {}),
  };
}

/** How far below the last price a suggested stop starts; the order editor changes it before review. */
export const SUGGESTED_STOP_DROP = 0.08;

/** The title of the basket that protects every holding without a full stop; the widget translates it. */
export const STOPS_BASKET_TITLE = "Stop-losses for unprotected holdings";

/**
 * Cents for ordinary prices; four significant digits below 1, where cents could round a stop up to the
 * price or down to zero. From 1 up, even a 1% drop is more than half a cent, so cents keep it below the price.
 */
function roundPrice(price: number): number {
  return price >= 1 ? Math.round(price * 100) / 100 : Number(price.toPrecision(4));
}

/**
 * A sell stop for the part of a holding no stop covers yet, up to the shares free to sell. It matches the
 * existing stop so the whole holding triggers at one price, or starts `drop` (8%) below the last price when
 * there is none or the price is already under it. Undefined when every share is covered or none is free.
 * Only a starting point: the order editor or basket review comes before anything is sent.
 */
export function suggestedStop(position: Position, guard: StopProtection | undefined, drop = SUGGESTED_STOP_DROP): { quantity: number; stopPrice: number } | undefined {
  if (!(position.currentPrice > 0)) return undefined;
  const uncovered = Number((position.quantity - (guard?.covered ?? 0)).toFixed(8));
  const quantity = Math.min(uncovered, position.quantityAvailableForTrading);
  if (!(quantity > 0)) return undefined;
  const stopPrice = guard && guard.stopPrice < position.currentPrice ? guard.stopPrice : roundPrice(position.currentPrice * (1 - drop));
  return { quantity, stopPrice };
}

export interface PortfolioProtection {
  holdings: number;
  /** Holdings whose pending sell stops cover every share. */
  covered: number;
  /** Holdings a sell stop covers only in part. */
  partial: number;
  /**
   * Account-currency value of the shares no stop covers, and its share of all holdings. Absent when a
   * holding has no account-currency value, since prices in other currencies cannot be added up.
   */
  unprotectedValue?: number;
  unprotectedShare?: number;
  /** Holdings with uncovered shares free to sell, which one stop basket can protect. */
  protectable: number;
}

/** Stop-loss coverage across the portfolio, for one line above the holdings. */
export function portfolioProtection(positions: Position[], orders: PendingOrder[]): PortfolioProtection {
  const held = positions.filter((position) => position.quantity > 0);
  let covered = 0;
  let partial = 0;
  let protectable = 0;
  let unprotected = 0;
  let total = 0;
  let valued = true;
  for (const position of held) {
    const guard = stopProtection(position, orders);
    if (guard?.coverage === 1) covered += 1;
    else if (guard) partial += 1;
    if (suggestedStop(position, guard)) protectable += 1;
    const value = (position.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
    if (typeof value !== "number" || !Number.isFinite(value)) valued = false;
    else {
      total += value;
      unprotected += value * (1 - (guard?.coverage ?? 0));
    }
  }
  return {
    holdings: held.length,
    covered,
    partial,
    protectable,
    ...(valued && total > 0 ? { unprotectedValue: unprotected, unprotectedShare: unprotected / total } : {}),
  };
}
