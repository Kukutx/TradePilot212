// Pure policy checks shared by single orders, baskets and unattended Demo automation.
// Every rule reports a result, so the confirmation UI can show what was checked, not just what failed.

import type { AccountSummary, Instrument, OrderDraft, Position } from "../shared/contracts.js";
import type { PolicyCheck, TradingPolicy } from "../shared/automation.js";
import type { MarketStatus } from "../shared/history.js";

export interface DailyUsage {
  orders: number;
  notional: number;
}

export interface PolicyInput {
  draft: OrderDraft;
  instrument: Instrument;
  position?: Position;
  account: AccountSummary;
  estimatedNotional?: number;
  market?: MarketStatus;
  /** Already submitted today, plus earlier legs of the same basket. */
  usage: DailyUsage;
  now?: Date;
}

export const EMPTY_USAGE: DailyUsage = { orders: 0, notional: 0 };

function ageSeconds(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, Math.floor((now.getTime() - time) / 1000)) : undefined;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export function evaluatePolicy(policy: TradingPolicy, input: PolicyInput): PolicyCheck[] {
  const { draft, instrument, position, account } = input;
  const now = input.now ?? new Date();
  const ticker = instrument.ticker.toUpperCase();
  const sameCurrency = !!account.currency && account.currency.toUpperCase() === instrument.currencyCode.toUpperCase();
  const checks: PolicyCheck[] = [];

  if (policy.allowedTickers.length) {
    const allowed = policy.allowedTickers.includes(ticker);
    checks.push({ rule: "allowed_tickers", status: allowed ? "pass" : "block", message: allowed ? `${ticker} is on the allowed list.` : `${ticker} is not on the allowed ticker list.` });
  }
  if (policy.blockedTickers.includes(ticker)) {
    checks.push({ rule: "blocked_tickers", status: "block", message: `${ticker} is on the blocked ticker list.` });
  }
  // Type limits only constrain new exposure; selling out of a disallowed type is always fine.
  if (policy.allowedTypes.length && draft.side === "buy") {
    const type = (instrument.type ?? "").toUpperCase();
    const allowed = policy.allowedTypes.includes(type);
    checks.push({ rule: "allowed_types", status: allowed ? "pass" : "block", message: allowed ? `${type} instruments are allowed.` : `Buying ${type || "this instrument type"} is not allowed (allowed: ${policy.allowedTypes.join(", ")}).` });
  }

  if (policy.maxPositionWeight > 0 && draft.side === "buy") {
    const totalValue = account.totalValue ?? 0;
    if (!sameCurrency || !totalValue || input.estimatedNotional === undefined) {
      checks.push({ rule: "max_position_weight", status: "skip", message: "Position weight cannot be computed without a same-currency price and account value." });
    } else {
      const heldValue = Math.max(0, position?.quantity ?? 0) * (position?.currentPrice ?? 0);
      const resulting = (heldValue + input.estimatedNotional) / totalValue;
      const over = resulting > policy.maxPositionWeight + 1e-9;
      checks.push({
        rule: "max_position_weight",
        status: over ? "block" : "pass",
        message: over
          ? `${ticker} would reach ${(resulting * 100).toFixed(1)}% of the account, above the ${(policy.maxPositionWeight * 100).toFixed(1)}% limit.`
          : `${ticker} would be ${(resulting * 100).toFixed(1)}% of the account.`,
        details: { resultingWeight: round(resulting), limit: policy.maxPositionWeight },
      });
    }
  }

  if (policy.dailyOrderLimit > 0) {
    const next = input.usage.orders + 1;
    const over = next > policy.dailyOrderLimit;
    checks.push({ rule: "daily_order_limit", status: over ? "block" : "pass", message: over ? `This would be order ${next} today; the daily limit is ${policy.dailyOrderLimit}.` : `Order ${next} of ${policy.dailyOrderLimit} today.`, details: { ordersToday: input.usage.orders, limit: policy.dailyOrderLimit } });
  }

  if (policy.dailyNotionalLimit > 0) {
    if (!sameCurrency || input.estimatedNotional === undefined) {
      checks.push({ rule: "daily_notional_limit", status: "warn", message: "This order's value is not counted toward the daily budget because it is in another currency or cannot be estimated." });
    } else {
      const next = input.usage.notional + input.estimatedNotional;
      const over = next > policy.dailyNotionalLimit + 1e-9;
      checks.push({ rule: "daily_notional_limit", status: over ? "block" : "pass", message: over ? `This would bring today's traded value to ${next.toFixed(2)} ${account.currency}, above the ${policy.dailyNotionalLimit} limit.` : `Today's traded value would be ${next.toFixed(2)} of ${policy.dailyNotionalLimit} ${account.currency}.`, details: { notionalToday: round(input.usage.notional, 2), limit: policy.dailyNotionalLimit } });
    }
  }

  // When closed Market orders are allowed, the order notices already explain the queueing.
  if (!policy.marketOrdersWhenClosed && draft.type === "market" && input.market && input.market.session !== "unknown" && !input.market.isOpen) {
    const extended = draft.extendedHours && ["pre_market", "after_hours", "overnight"].includes(input.market.session);
    if (!extended) {
      checks.push({
        rule: "market_closed",
        status: "block",
        message: "Market orders are blocked while the market is closed. Use a Limit order or wait for the open.",
        details: { session: input.market.session, nextOpen: input.market.nextOpen ?? null },
      });
    }
  }

  if (policy.maxReferenceAgeSeconds > 0 && draft.type === "market" && draft.referencePrice !== undefined) {
    const age = ageSeconds(draft.referencePriceAt, now);
    const stale = age === undefined || age > policy.maxReferenceAgeSeconds;
    checks.push({ rule: "reference_age", status: stale ? "block" : "pass", message: stale ? `The reference price is ${age === undefined ? "undated" : `${age}s old`}; the policy requires one newer than ${policy.maxReferenceAgeSeconds}s.` : `Reference price is ${age}s old.`, ...(age === undefined ? {} : { details: { ageSeconds: age } }) });
  }

  return checks;
}

export function blockingChecks(checks: PolicyCheck[]): PolicyCheck[] {
  return checks.filter((check) => check.status === "block");
}

export function usageKey(environment: string, now = new Date()): string {
  return `usage:${environment}:${now.toISOString().slice(0, 10)}`;
}

/** Add an order to the running usage; only same-currency notional counts toward the budget. */
export function addUsage(usage: DailyUsage, estimatedNotional: number | undefined, sameCurrency: boolean): DailyUsage {
  return { orders: usage.orders + 1, notional: usage.notional + (sameCurrency && estimatedNotional ? estimatedNotional : 0) };
}
