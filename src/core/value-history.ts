// A daily record of the account's total value. Trading 212's API reports only today's value, so the
// scheduler reads the account summary about once an hour and keeps the last value it saw each UTC
// day. Days the server was not running have no point. Values include deposits and withdrawals.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { ValuePoint } from "../shared/history.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

const HOUR_MS = 3_600_000;
/** Points are kept for about six years. */
const KEEP_MS = 6 * 366 * 86_400_000;
// One key per month keeps each stored value small (Durable Object values are capped).
const monthKey = (environment: TradingEnvironment, date: string) => `value-history:${environment}:${date.slice(0, 7)}`;
const round = (value: number) => Math.round(value * 100) / 100;

export class ValueHistory {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  /** One scheduler tick: about once an hour per environment, record today's value. */
  async snapshot(now = new Date()): Promise<Array<{ environment: TradingEnvironment; point: ValuePoint }>> {
    const credentials = credentialStatus(this.deps.config);
    const recorded: Array<{ environment: TradingEnvironment; point: ValuePoint }> = [];
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      const slot = await this.deps.store.increment(`value-snapshot:${environment}`, HOUR_MS, now.getTime());
      if (slot.count > 1) continue;
      const account = await this.deps.trading.accountSummary(environment);
      if (typeof account.totalValue !== "number" || !Number.isFinite(account.totalValue)) continue;
      const point: ValuePoint = {
        date: now.toISOString().slice(0, 10),
        totalValue: round(account.totalValue),
        ...(typeof account.cash?.availableToTrade === "number" ? { cash: round(account.cash.availableToTrade) } : {}),
        ...(typeof account.investments?.currentValue === "number" ? { invested: round(account.investments.currentValue) } : {}),
        at: now.toISOString(),
      };
      await this.record(environment, point);
      recorded.push({ environment, point });
    }
    return recorded;
  }

  /** Store a point, replacing any earlier one for the same day. */
  async record(environment: TradingEnvironment, point: ValuePoint): Promise<void> {
    const key = monthKey(environment, point.date);
    const month = ((await this.deps.store.get<ValuePoint[]>(key)) ?? []).filter((item) => item.date !== point.date);
    const points = [...month, point].sort((a, b) => a.date.localeCompare(b.date));
    await this.deps.store.put(key, points, Date.parse(point.at) + KEEP_MS);
  }

  /** Recorded days from `from` (a date or time; inclusive) to `to`, oldest first. */
  async points(environment: TradingEnvironment, range: { from?: string; to?: string } = {}): Promise<ValuePoint[]> {
    const from = range.from?.slice(0, 10);
    const to = range.to?.slice(0, 10);
    return (await this.deps.store.list<ValuePoint[]>(`value-history:${environment}:`))
      .flatMap((entry) => entry.value)
      .filter((point) => (!from || point.date >= from) && (!to || point.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
