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
const monthKey = (series: string, date: string) => `value-history:${series}:${date.slice(0, 7)}`;
const round = (value: number) => Math.round(value * 100) / 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A recorded day and the Trading 212 account it was read from; the account id is not shown. */
interface StoredPoint extends ValuePoint { account?: number }

/** Whether a point is on the right side of a bound: a date compares whole days, a time compares when the value was read. */
function within(point: ValuePoint, bound: string | undefined, side: "from" | "to"): boolean {
  if (!bound) return true;
  const time = Date.parse(bound);
  if (DATE_ONLY.test(bound) || Number.isNaN(time)) return side === "from" ? point.date >= bound.slice(0, 10) : point.date <= bound.slice(0, 10);
  const read = Date.parse(point.at);
  return side === "from" ? read >= time : read <= time;
}

export class ValueHistory {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  /** The simulated account keeps its own days, so switching to a real Demo account starts a clean record. */
  private series(environment: TradingEnvironment): string {
    return this.deps.config.sampleData && environment === "demo" ? "sample" : environment;
  }

  /** One scheduler tick: about once an hour per environment, record today's value. */
  async snapshot(now = new Date()): Promise<Array<{ environment: TradingEnvironment; point: ValuePoint }>> {
    const credentials = credentialStatus(this.deps.config);
    const recorded: Array<{ environment: TradingEnvironment; point: ValuePoint }> = [];
    const started = Date.now();
    for (const environment of ["demo", "live"] as const) {
      if (!credentials[environment]) continue;
      const slot = await this.deps.store.increment(`value-snapshot:${environment}`, HOUR_MS, now.getTime());
      if (slot.count > 1) continue;
      const account = await this.deps.trading.accountSummary(environment);
      if (typeof account.totalValue !== "number" || !Number.isFinite(account.totalValue)) continue;
      // The value is as of when Trading 212 answered: a read that starts before midnight UTC and ends after it belongs to the new day.
      const read = new Date(now.getTime() + Date.now() - started);
      const point: StoredPoint = {
        date: read.toISOString().slice(0, 10),
        totalValue: round(account.totalValue),
        ...(typeof account.cash?.availableToTrade === "number" ? { cash: round(account.cash.availableToTrade) } : {}),
        ...(typeof account.investments?.currentValue === "number" ? { invested: round(account.investments.currentValue) } : {}),
        at: read.toISOString(),
        ...(typeof account.id === "number" ? { account: account.id } : {}),
      };
      await this.record(environment, point);
      const { account: _account, ...shown } = point;
      recorded.push({ environment, point: shown });
    }
    return recorded;
  }

  /** Store a point, replacing any earlier one for the same day. */
  async record(environment: TradingEnvironment, point: StoredPoint): Promise<void> {
    const key = monthKey(this.series(environment), point.date);
    const month = ((await this.deps.store.get<StoredPoint[]>(key)) ?? []).filter((item) => item.date !== point.date);
    const points = [...month, point].sort((a, b) => a.date.localeCompare(b.date));
    await this.deps.store.put(key, points, Date.parse(point.at) + KEEP_MS);
  }

  /**
   * Recorded days from `from` to `to` (inclusive), oldest first. A date bound compares whole days; a
   * date-time bound compares when each value was read. After a switch to another Trading 212 account,
   * only the current account's days are returned.
   */
  async points(environment: TradingEnvironment, range: { from?: string; to?: string } = {}): Promise<ValuePoint[]> {
    const stored = (await this.deps.store.list<StoredPoint[]>(`value-history:${this.series(environment)}:`))
      .flatMap((entry) => entry.value)
      .sort((a, b) => a.date.localeCompare(b.date));
    const current = stored[stored.length - 1]?.account;
    return stored
      .filter((point) => point.account === current && within(point, range.from, "from") && within(point, range.to, "to"))
      .map(({ account: _account, ...point }) => point);
  }
}
