// A once-a-day account digest sent to the notification webhook at DIGEST_HOUR_UTC, so you can
// follow the account without opening a chat. It only reads; it never trades. It is sent whatever
// NOTIFY_EVENTS lists, and a day counts as done only once the webhook accepted it.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { DcaPlan, PriceAlert, TargetAllocation } from "../shared/automation.js";
import { analyzeAllocation, positionValue } from "./analytics.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { Notifier } from "./notify.js";
import type { StateStore } from "./state-store.js";
import { allocationDrift } from "./targets.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
const round = (value: number) => Math.round(value * 100) / 100;
const signed = (value: number) => `${value >= 0 ? "+" : ""}${round(value)}`;

export interface DigestInput {
  environment: TradingEnvironment;
  currency: string;
  totalValue: number;
  previousTotalValue?: number;
  cash: number;
  unrealized?: number;
  positions: Array<{ ticker: string; value: number; profitLoss?: number }>;
  pendingOrders: number;
  duePlans: string[];
  triggeredAlerts: number;
  /** Largest drift from the saved targets, in weight points, when targets are saved. */
  maxDrift?: number;
}

/** Plain-text digest; kept short so it reads well in a chat notification. */
export function digestText(input: DigestInput): string {
  const change = input.previousTotalValue === undefined ? "" : ` (${signed(input.totalValue - input.previousTotalValue)} since the last digest)`;
  const top = [...input.positions].sort((a, b) => b.value - a.value).slice(0, 3)
    .map((item) => `${item.ticker} ${round(item.value)}${item.profitLoss === undefined ? "" : ` (${signed(item.profitLoss)})`}`);
  return [
    `Total ${round(input.totalValue)} ${input.currency}${change}`,
    `cash ${round(input.cash)}`,
    input.unrealized === undefined ? undefined : `unrealized ${signed(input.unrealized)}`,
    top.length ? `top: ${top.join(", ")}` : undefined,
    input.pendingOrders ? `${input.pendingOrders} pending order(s)` : undefined,
    input.duePlans.length ? `due plans: ${input.duePlans.join(", ")}` : undefined,
    input.triggeredAlerts ? `${input.triggeredAlerts} alert(s) triggered in the last day` : undefined,
    input.maxDrift === undefined ? undefined : `largest drift from targets ${(input.maxDrift * 100).toFixed(1)} points`,
  ].filter(Boolean).join(" · ");
}

const RETRY_MS = 15 * 60_000;

export class DailyDigest {
  constructor(private readonly deps: {
    config: RuntimeConfig; store: StateStore; trading: TradingService; notify?: Notifier;
    targets?: (environment: TradingEnvironment) => Promise<TargetAllocation | undefined>;
  }) {}

  /** Send at most one digest per environment per UTC day, at or after DIGEST_HOUR_UTC. */
  async run(now = new Date()): Promise<string[]> {
    const hour = this.deps.config.digestHourUtc;
    if (hour === undefined || !this.deps.notify || now.getUTCHours() < hour) return [];
    const day = now.toISOString().slice(0, 10);
    const sent: string[] = [];
    const credentials = credentialStatus(this.deps.config);
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      // A failed attempt (rate limit, outage) is retried every 15 minutes for the rest of the day.
      const attempt = await this.deps.store.increment(`digest-try:${environment}:${day}`, RETRY_MS, now.getTime());
      if (attempt.count > 1) continue;
      const claimKey = `digest:${environment}:${day}`;
      const claim = await this.deps.store.increment(claimKey, 2 * DAY_MS, now.getTime());
      if (claim.count > 1) continue;
      try {
        const dashboard = await this.deps.trading.getDashboard(environment);
        const account = dashboard.account;
        if (!account) {
          await this.deps.store.delete(claimKey);
          continue;
        }
        const previous = await this.deps.store.get<number>(`digest-value:${environment}`);
        const plans = (await this.deps.store.list<DcaPlan>("plan:")).map((entry) => entry.value)
          .filter((plan) => plan.environment === environment && !plan.paused && Date.parse(plan.nextRunAt) <= now.getTime());
        const alerts = (await this.deps.store.list<PriceAlert>("alert:")).map((entry) => entry.value)
          .filter((alert) => alert.environment === environment && alert.triggeredAt && Date.parse(alert.triggeredAt) > now.getTime() - DAY_MS);
        const totalValue = account.totalValue ?? 0;
        // Drift from the same account read, so the digest costs no extra request.
        const saved = await this.deps.targets?.(environment);
        const maxDrift = saved ? allocationDrift(saved, analyzeAllocation(environment, account, dashboard.positions)).maxDrift : undefined;
        const text = digestText({
          environment,
          currency: account.currency ?? "",
          totalValue,
          ...(previous === undefined ? {} : { previousTotalValue: previous }),
          cash: account.cash?.availableToTrade ?? 0,
          ...(account.investments?.unrealizedProfitLoss === undefined ? {} : { unrealized: account.investments.unrealizedProfitLoss }),
          positions: dashboard.positions.map((position) => {
            const wallet = position.walletImpact as { unrealizedProfitLoss?: unknown } | undefined;
            return { ticker: position.instrument.ticker, value: positionValue(position), ...(typeof wallet?.unrealizedProfitLoss === "number" ? { profitLoss: wallet.unrealizedProfitLoss } : {}) };
          }),
          pendingOrders: dashboard.orders.length,
          duePlans: plans.map((plan) => plan.label),
          triggeredAlerts: alerts.length,
          ...(maxDrift === undefined ? {} : { maxDrift }),
        });
        const event = { id: crypto.randomUUID(), timestamp: now.toISOString(), environment, type: "daily_digest" as const, outcome: text };
        if (!(await this.deps.notify!(event, { force: true }))) {
          // Not delivered: release the day so the next attempt window sends it again.
          await this.deps.store.delete(claimKey);
          continue;
        }
        await this.deps.store.put(`digest-value:${environment}`, totalValue);
        await this.deps.trading.recordActivity("daily_digest", environment, { outcome: text }, { notify: false });
        sent.push(environment);
      } catch (error) {
        await this.deps.store.delete(claimKey).catch(() => {});
        console.error(JSON.stringify({ message: "TradePilot digest failed", environment, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return sent;
  }
}
