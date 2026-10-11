// A once-a-day account digest sent to the notification webhook at DIGEST_HOUR_UTC, so you can
// follow the account without opening a chat. It only reads; it never trades.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { DcaPlan, PriceAlert } from "../shared/automation.js";
import { positionValue } from "./analytics.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
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
  ].filter(Boolean).join(" · ");
}

export class DailyDigest {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  /** Send at most one digest per environment per UTC day, at or after DIGEST_HOUR_UTC. */
  async run(now = new Date()): Promise<string[]> {
    const hour = this.deps.config.digestHourUtc;
    if (hour === undefined || !this.deps.config.notifyWebhookUrl || now.getUTCHours() < hour) return [];
    const day = now.toISOString().slice(0, 10);
    const sent: string[] = [];
    const credentials = credentialStatus(this.deps.config);
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      const claim = await this.deps.store.increment(`digest:${environment}:${day}`, 2 * DAY_MS, now.getTime());
      if (claim.count > 1) continue;
      try {
        const dashboard = await this.deps.trading.getDashboard(environment);
        const account = dashboard.account;
        if (!account) continue;
        const previous = await this.deps.store.get<number>(`digest-value:${environment}`);
        const plans = (await this.deps.store.list<DcaPlan>("plan:")).map((entry) => entry.value)
          .filter((plan) => plan.environment === environment && !plan.paused && Date.parse(plan.nextRunAt) <= now.getTime());
        const alerts = (await this.deps.store.list<PriceAlert>("alert:")).map((entry) => entry.value)
          .filter((alert) => alert.environment === environment && alert.triggeredAt && Date.parse(alert.triggeredAt) > now.getTime() - DAY_MS);
        const totalValue = account.totalValue ?? 0;
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
        });
        await this.deps.store.put(`digest-value:${environment}`, totalValue);
        await this.deps.trading.recordActivity("daily_digest", environment, { outcome: text });
        sent.push(environment);
      } catch (error) {
        console.error(JSON.stringify({ message: "TradePilot digest failed", environment, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return sent;
  }
}
