// Watches the open orders and reports how each one ended once it leaves the order book: filled,
// partly filled, or closed without a fill (cancelled, rejected, expired). It covers orders placed
// anywhere, the Trading 212 app included, and only reads: it never places or cancels anything.
// Orders that open and fill between two checks (most market orders) are not seen; their own result
// already says how they went. Set ORDER_WATCH=false to turn it off.

import type { OrderType, PendingOrder, TradingEnvironment } from "../shared/contracts.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { OrderOutcome, TradingService } from "./trading-service.js";

export const ORDER_WATCH_INTERVAL_MS = 5 * 60_000;
/** Checks an order may be missing from the book without a final history entry before it is reported as unclear. */
export const MAX_MISSING_CHECKS = 3;
const DAY_MS = 86_400_000;
const watchKey = (environment: TradingEnvironment) => `order-watch:${environment}`;
// Fill times of the last two days, kept apart from the activity log, which keeps only its newest events.
const fillsKey = (environment: TradingEnvironment) => `order-fills:${environment}`;
const MAX_FILL_TIMES = 2000;

/** Orders the watch saw fill, fully or partly, in the 24 hours before `now`. */
export async function recentFillCount(store: StateStore, environment: TradingEnvironment, now = new Date()): Promise<number> {
  const times = (await store.get<string[]>(fillsKey(environment))) ?? [];
  return times.filter((time) => Date.parse(time) > now.getTime() - DAY_MS).length;
}

export interface WatchedOrder {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  type?: string;
  /** Shares ordered; absent for orders placed by value in the Trading 212 app. */
  quantity?: number;
  value?: number;
  limitPrice?: number;
  stopPrice?: number;
  createdAt?: string;
  /** Checks since the order left the book without showing up in the order history. */
  missing?: number;
}

interface WatchState { orders: WatchedOrder[]; checkedAt: string }

export interface OrderWatchReport {
  environment: TradingEnvironment;
  orderId: string;
  ticker: string;
  result: "filled" | "partly_filled" | "closed" | "unclear";
  message: string;
}

type Outcome = Pick<OrderWatchReport, "result" | "message"> & { outcome?: OrderOutcome };

const ORDER_TYPES: Record<string, OrderType> = { MARKET: "market", LIMIT: "limit", STOP: "stop", STOP_LIMIT: "stop_limit" };
const amount = (value: number) => String(Math.round(value * 1e8) / 1e8);

export function watchedOrder(order: PendingOrder): WatchedOrder | undefined {
  if (order.id === undefined || order.id === null || !order.ticker) return undefined;
  const quantity = typeof order.quantity === "number" && Number.isFinite(order.quantity) ? order.quantity : undefined;
  const value = typeof order.value === "number" && Number.isFinite(order.value) ? order.value : undefined;
  // Sells carry negative quantities (or values) when the side is not given.
  const side = order.side ? (/SELL/i.test(String(order.side)) ? "sell" : "buy") : (quantity ?? value ?? 0) < 0 ? "sell" : "buy";
  return {
    id: String(order.id),
    ticker: order.ticker,
    side,
    ...(order.type ? { type: String(order.type).toUpperCase() } : {}),
    ...(quantity ? { quantity: Math.abs(quantity) } : {}),
    ...(value ? { value: Math.abs(value) } : {}),
    ...(typeof order.limitPrice === "number" ? { limitPrice: order.limitPrice } : {}),
    ...(typeof order.stopPrice === "number" ? { stopPrice: order.stopPrice } : {}),
    ...(order.createdAt ? { createdAt: order.createdAt } : {}),
  };
}

const fullyFilled = (outcome: OrderOutcome) => outcome.quantity > 0 && outcome.filledQuantity >= outcome.quantity * (1 - 1e-6);

/**
 * Whether the history shows how the order ended. While it still shows an earlier state (new, partly
 * filled, being cancelled), a later entry may follow, so the watch waits for it.
 */
export function isFinal(outcome: OrderOutcome): boolean {
  if (fullyFilled(outcome)) return true;
  const status = outcome.status;
  return /FILLED|CANCEL|REJECT|EXPIRE|REPLACED/.test(status) && !/PARTIAL|CANCELLING|REPLACING/.test(status);
}

/** How an order that left the book ended, from its final history entry. */
export function describeOutcome(order: WatchedOrder, outcome: OrderOutcome): Pick<OrderWatchReport, "result" | "message"> {
  const status = outcome.status;
  const filled = outcome.filledQuantity;
  const ordered = outcome.quantity || order.quantity || 0;
  const price = outcome.averagePrice === undefined ? "" : ` at ${amount(outcome.averagePrice)}`;
  const value = outcome.filledValue === undefined ? "" : ` (${outcome.filledValue.toFixed(2)}${outcome.filledValueCurrency ? ` ${outcome.filledValueCurrency}` : ""})`;
  const closedEarly = /CANCEL|REJECT|EXPIRE/.test(status);
  if (filled > 0 && ordered > 0 && filled < ordered * (1 - 1e-6))
    return { result: "partly_filled", message: `Filled ${amount(filled)} of ${amount(ordered)}${price}${value}; the rest closed${status ? ` (${status})` : ""}.` };
  // An order placed by value has no share count to compare with; a cancel, reject or expiry after a fill was partial.
  if (filled > 0 && ordered === 0 && closedEarly)
    return { result: "partly_filled", message: `Filled ${amount(filled)}${price}${value} before the rest closed (${status}).` };
  if (filled > 0 || (/FILLED/.test(status) && !/UNFILLED|PARTIAL|REJECT/.test(status)))
    return { result: "filled", message: `Filled${filled > 0 ? ` ${amount(filled)}` : ""}${price}${value}.` };
  return { result: "closed", message: `Closed without a fill${status ? ` (${status})` : ""}.` };
}

export class OrderWatch {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  /**
   * One scheduler tick: about every 5 minutes per environment, compare the open orders with the last
   * check and report each order that left the book. The first check only records what is open.
   */
  async check(now = new Date()): Promise<OrderWatchReport[]> {
    if (!this.deps.config.orderWatch) return [];
    const credentials = credentialStatus(this.deps.config);
    const reports: OrderWatchReport[] = [];
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      const slot = await this.deps.store.increment(`order-watch-slot:${environment}`, ORDER_WATCH_INTERVAL_MS, now.getTime());
      if (slot.count > 1) continue;
      const open = (await this.deps.trading.pendingOrders(environment)).flatMap((order) => watchedOrder(order) ?? []);
      const previous = await this.deps.store.get<WatchState>(watchKey(environment));
      const openIds = new Set(open.map((order) => order.id));
      const gone = (previous?.orders ?? []).filter((order) => !openIds.has(order.id));
      const kept: WatchedOrder[] = [];
      if (gone.length) {
        let outcomes: Map<string, OrderOutcome> | undefined;
        try {
          // No time bound: history can list an old order's recent fill before a newer order, so paging
          // stops once every wanted order is found or after the default number of pages.
          outcomes = await this.deps.trading.recentOrderOutcomes(environment, { wanted: gone.map((order) => order.id) });
        } catch {
          // The history could not be read: look again at the next check.
          kept.push(...gone);
        }
        for (const order of outcomes ? gone : []) {
          const outcome = outcomes!.get(order.id);
          if (outcome && isFinal(outcome)) {
            reports.push(await this.report(environment, order, { ...describeOutcome(order, outcome), outcome }, now));
            continue;
          }
          // The history can lag the order book by a little; give it a few checks before calling it unclear.
          if ((order.missing ?? 0) + 1 < MAX_MISSING_CHECKS) { kept.push({ ...order, missing: (order.missing ?? 0) + 1 }); continue; }
          const seen = outcome
            ? `the order history still shows it as ${outcome.status || "open"}${outcome.filledQuantity > 0 ? ` with ${amount(outcome.filledQuantity)} filled` : ""}`
            : "the order history does not show how it ended";
          reports.push(await this.report(environment, order, { result: "unclear", message: `Left the order book, but ${seen}. Check it in Trading 212.`, ...(outcome ? { outcome } : {}) }, now));
        }
      }
      await this.deps.store.put(watchKey(environment), { orders: [...open, ...kept], checkedAt: now.toISOString() } satisfies WatchState);
    }
    return reports;
  }

  private async report(environment: TradingEnvironment, order: WatchedOrder, found: Outcome, now: Date): Promise<OrderWatchReport> {
    const type = ({ filled: "order_filled", partly_filled: "order_partly_filled", closed: "order_closed", unclear: "order_outcome_unknown" } as const)[found.result];
    const orderType = order.type ? ORDER_TYPES[order.type] : undefined;
    const outcome = found.outcome;
    const filled = found.result === "filled" || found.result === "partly_filled";
    await this.deps.trading.recordActivity(type, environment, {
      ticker: order.ticker,
      orderId: order.id,
      side: order.side,
      ...(orderType ? { orderType } : {}),
      ...(order.quantity ? { quantity: order.quantity } : {}),
      // The fill facts, so the widget can show them in its own language.
      ...(filled && outcome && outcome.filledQuantity > 0 ? { filledQuantity: outcome.filledQuantity } : {}),
      ...(filled && outcome?.averagePrice !== undefined ? { price: outcome.averagePrice } : {}),
      ...(filled && outcome?.filledValue !== undefined ? { value: outcome.filledValue, ...(outcome.filledValueCurrency ? { valueCurrency: outcome.filledValueCurrency } : {}) } : {}),
      outcome: found.message.slice(0, 200),
    });
    if (filled) {
      const times = ((await this.deps.store.get<string[]>(fillsKey(environment))) ?? []).filter((time) => Date.parse(time) > now.getTime() - 2 * DAY_MS);
      await this.deps.store.put(fillsKey(environment), [...times, now.toISOString()].slice(-MAX_FILL_TIMES));
    }
    return { environment, orderId: order.id, ticker: order.ticker, result: found.result, message: found.message };
  }
}
