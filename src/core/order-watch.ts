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
/** Checks an order may be missing from both the book and the history before it is reported as unclear. */
export const MAX_MISSING_CHECKS = 3;
const watchKey = (environment: TradingEnvironment) => `order-watch:${environment}`;

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

/** How an order that left the book ended, from its history entry. */
export function describeOutcome(order: WatchedOrder, outcome: OrderOutcome): Pick<OrderWatchReport, "result" | "message"> {
  const status = outcome.status;
  const filled = outcome.filledQuantity;
  const ordered = outcome.quantity || order.quantity || 0;
  const price = outcome.averagePrice === undefined ? "" : ` at ${amount(outcome.averagePrice)}`;
  const value = outcome.filledValue === undefined ? "" : ` (${outcome.filledValue.toFixed(2)}${outcome.filledValueCurrency ? ` ${outcome.filledValueCurrency}` : ""})`;
  if (filled > 0 && ordered > 0 && filled < ordered * (1 - 1e-6))
    return { result: "partly_filled", message: `Filled ${amount(filled)} of ${amount(ordered)}${price}${value}; the rest closed${status ? ` (${status})` : ""}.` };
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
          const since = gone.map((order) => order.createdAt ?? "").filter(Boolean).sort()[0];
          outcomes = await this.deps.trading.recentOrderOutcomes(environment, { wanted: gone.map((order) => order.id), ...(since ? { since } : {}) });
        } catch {
          // The history could not be read: look again at the next check.
          kept.push(...gone);
        }
        for (const order of outcomes ? gone : []) {
          const outcome = outcomes!.get(order.id);
          // The history can lag the order book by a little; give it a few checks before calling it unclear.
          if (!outcome) {
            if ((order.missing ?? 0) + 1 < MAX_MISSING_CHECKS) { kept.push({ ...order, missing: (order.missing ?? 0) + 1 }); continue; }
            reports.push(await this.report(environment, order, { result: "unclear", message: "Left the order book, but the order history does not show how it ended. Check it in Trading 212." }));
            continue;
          }
          reports.push(await this.report(environment, order, describeOutcome(order, outcome)));
        }
      }
      await this.deps.store.put(watchKey(environment), { orders: [...open, ...kept], checkedAt: now.toISOString() } satisfies WatchState);
    }
    return reports;
  }

  private async report(environment: TradingEnvironment, order: WatchedOrder, outcome: Pick<OrderWatchReport, "result" | "message">): Promise<OrderWatchReport> {
    const type = outcome.result === "filled" ? "order_filled" : outcome.result === "partly_filled" ? "order_partly_filled" : "order_closed";
    const orderType = order.type ? ORDER_TYPES[order.type] : undefined;
    await this.deps.trading.recordActivity(type, environment, {
      ticker: order.ticker,
      orderId: order.id,
      side: order.side,
      ...(orderType ? { orderType } : {}),
      ...(order.quantity ? { quantity: order.quantity } : {}),
      outcome: outcome.message.slice(0, 200),
    });
    return { environment, orderId: order.id, ticker: order.ticker, ...outcome };
  }
}
