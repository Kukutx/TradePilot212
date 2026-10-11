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
  const last = position.currentPrice;
  return {
    ticker,
    stopPrice,
    ...(last > 0 ? { gap: (stopPrice - last) / last } : {}),
    covered,
    coverage: covered >= position.quantity ? 1 : covered / position.quantity,
    orders: stops.length,
  };
}

/** How far below the last price a suggested stop starts; the order editor changes it before review. */
export const SUGGESTED_STOP_DROP = 0.08;

/**
 * A sell stop for the part of a holding no stop covers yet, up to the shares free to sell. It matches the
 * existing stop so the whole holding triggers at one price, or starts 8% below the last price when there is
 * none or the price is already under it. Undefined when every share is covered or none is free. Only a
 * starting point for the editor.
 */
export function suggestedStop(position: Position, guard: StopProtection | undefined): { quantity: number; stopPrice: number } | undefined {
  if (!(position.currentPrice > 0)) return undefined;
  const uncovered = Number((position.quantity - (guard?.covered ?? 0)).toFixed(8));
  const quantity = Math.min(uncovered, position.quantityAvailableForTrading);
  if (!(quantity > 0)) return undefined;
  const stopPrice = guard && guard.stopPrice < position.currentPrice ? guard.stopPrice : Math.round(position.currentPrice * (1 - SUGGESTED_STOP_DROP) * 100) / 100;
  return { quantity, stopPrice };
}
