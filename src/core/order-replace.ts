// Changing an open order (2.100). Trading 212's API has no edit: an order is changed by cancelling it and placing the
// new one. These are the pure parts: the order that would replace an open one, and what the open one holds back. The
// send itself (trading-service.ts executeReplace) waits for the cancel to be confirmed, with no fill, before it places
// anything, and never places the new order a second time on its own.

import type { OrderDraft, OrderSide, OrderType, PendingOrder, ReplaceChanges, TimeValidity, TradingEnvironment } from "../shared/contracts.js";
import { fail } from "./errors.js";

const TYPES: OrderType[] = ["market", "limit", "stop", "stop_limit"];

/** The order's type as a draft names it, from Trading 212's "LIMIT", "STOP_LIMIT" (or "STOP-LIMIT"). */
export function orderTypeOf(order: PendingOrder): OrderType | undefined {
  const type = String(order.type ?? "").replaceAll("-", "_").toLowerCase();
  return (TYPES as string[]).includes(type) ? (type as OrderType) : undefined;
}

/** Buy or sell: Trading 212 gives the side, and a sell's quantity is negative. */
export function orderSideOf(order: PendingOrder): OrderSide {
  const side = String(order.side ?? "").toLowerCase();
  if (side === "buy" || side === "sell") return side;
  return Number(order.quantity) < 0 ? "sell" : "buy";
}

const filledOf = (order: PendingOrder) => Math.abs(Number(order.filledQuantity ?? 0)) || 0;
const sizeOf = (order: PendingOrder) => Math.abs(Number(order.quantity ?? 0)) || 0;
const validityOf = (order: PendingOrder): TimeValidity | undefined => {
  const value = String(order.timeInForce ?? order.timeValidity ?? "").toUpperCase();
  return value === "DAY" || value === "GOOD_TILL_CANCEL" ? value : undefined;
};

/**
 * The order that replaces `original` with `changes`: the same instrument, side and type, the changed quantity, prices
 * or validity, and the rest as they were. Refused when the order can't be changed this way: a Market order (it fills at
 * once), one placed by amount in the Trading 212 app (its quantity is not its own), one that has filled in part (only
 * the rest is open), or a change that changes nothing.
 */
export function replacementDraft(environment: TradingEnvironment, original: PendingOrder, changes: ReplaceChanges): OrderDraft {
  const ticker = String(original.ticker ?? (original.instrument as { ticker?: string } | undefined)?.ticker ?? "").trim();
  if (!ticker) fail("INVALID_INPUT", "The order's instrument is not known, so it can't be changed here. Change it in Trading 212.", { reason: "unknown" });
  const type = orderTypeOf(original);
  if (!type) fail("INVALID_INPUT", `Order type ${String(original.type ?? "")} can't be changed here. Change it in Trading 212.`, { reason: "unknown" });
  if (type === "market") fail("INVALID_INPUT", "A Market order fills at once, so it can't be changed.", { reason: "market" });
  if (String(original.strategy ?? "QUANTITY").toUpperCase() === "VALUE")
    fail("INVALID_INPUT", "This order was placed by amount in the Trading 212 app; change it there.", { reason: "value" });
  if (filledOf(original) > 0)
    fail("INVALID_INPUT", `This order has already filled ${filledOf(original)} of ${sizeOf(original)}; only the rest is open. Cancel it and place a new order for what you want.`, { reason: "partly_filled" });
  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";
  if (changes.limitPrice !== undefined && !needsLimit) fail("INVALID_INPUT", "This order has no limit price to change.", { field: "limitPrice" });
  if (changes.stopPrice !== undefined && !needsStop) fail("INVALID_INPUT", "This order has no stop price to change.", { field: "stopPrice" });
  for (const [name, value] of [["quantity", changes.quantity], ["limitPrice", changes.limitPrice], ["stopPrice", changes.stopPrice]] as const)
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) fail("INVALID_INPUT", `${name} must be a positive number`, { field: name });
  const draft: OrderDraft = {
    environment,
    ticker,
    side: orderSideOf(original),
    type,
    quantity: changes.quantity ?? sizeOf(original),
    timeValidity: changes.timeValidity ?? validityOf(original) ?? "DAY",
    ...(needsLimit ? { limitPrice: changes.limitPrice ?? Number(original.limitPrice) } : {}),
    ...(needsStop ? { stopPrice: changes.stopPrice ?? Number(original.stopPrice) } : {}),
  };
  const same = Math.abs(draft.quantity - sizeOf(original)) <= 1e-9
    && (!needsLimit || draft.limitPrice === Number(original.limitPrice))
    && (!needsStop || draft.stopPrice === Number(original.stopPrice))
    && draft.timeValidity === (validityOf(original) ?? "DAY");
  if (same) fail("INVALID_INPUT", "The change keeps the order as it is: nothing to send.", { reason: "unchanged" });
  return draft;
}

/** Whether an open order still reads as it did at the review: an order changed in the app since is not the one shown. */
export function sameOpenOrder(reviewed: PendingOrder, now: PendingOrder): boolean {
  const num = (value: unknown) => (value === undefined || value === null ? undefined : Number(value));
  return sizeOf(reviewed) === sizeOf(now)
    && filledOf(now) === filledOf(reviewed)
    && num(reviewed.limitPrice) === num(now.limitPrice)
    && num(reviewed.stopPrice) === num(now.stopPrice)
    && validityOf(reviewed) === validityOf(now);
}

/**
 * What the open order holds back that its cancel gives back, for checking the new order: a sell's shares, and a buy's
 * cash at its limit (or its stop), in the instrument's currency. A Stop buy with no price holds back an amount Trading
 * 212 sets, which is not counted.
 */
export function heldBack(order: PendingOrder): { shares: number; value: number } {
  const open = Math.max(0, sizeOf(order) - filledOf(order));
  if (orderSideOf(order) === "sell") return { shares: open, value: 0 };
  const price = Number(order.limitPrice ?? order.stopPrice ?? 0);
  return { shares: 0, value: Number.isFinite(price) && price > 0 ? open * price : 0 };
}
