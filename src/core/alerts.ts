// Price alerts, checked by the scheduler against the held position's price or, for instruments you
// do not hold, the external quote provider. A triggered alert writes a
// price_alert_triggered activity event (and webhook, when configured) once, then stays
// triggered until it is re-armed. Alerts never place or cancel orders.

import type { Position, TradingEnvironment } from "../shared/contracts.js";
import type { AlertCondition, AlertReport, PriceAlert } from "../shared/automation.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import { randomToken } from "./web-utils.js";

export const MAX_ALERTS = 50;
const alertKey = (id: string) => `alert:${id}`;

export interface AlertInput {
  environment: TradingEnvironment;
  instrument: string;
  condition: AlertCondition;
  price?: number;
  percent?: number;
  note?: string;
}

/** Whether `alert` fires at `price`, and the new high-water mark for trailing alerts. */
export function evaluateAlert(alert: PriceAlert, position: Pick<Position, "currentPrice" | "averagePricePaid">): { fired: boolean; highWatermark?: number; message: string } {
  const price = position.currentPrice;
  switch (alert.condition) {
    case "above":
      return { fired: price >= alert.price!, message: `${alert.ticker} is at ${price}, at or above ${alert.price}.` };
    case "below":
      return { fired: price <= alert.price!, message: `${alert.ticker} is at ${price}, at or below ${alert.price}.` };
    case "trailing_drop": {
      const high = Math.max(alert.highWatermark ?? price, price);
      const trigger = high * (1 - alert.percent! / 100);
      return { fired: price <= trigger, highWatermark: high, message: `${alert.ticker} is at ${price}, ${(((high - price) / high) * 100).toFixed(2)}% below its high of ${high} (alert at ${alert.percent}%).` };
    }
    case "gain_percent":
    case "loss_percent": {
      const cost = position.averagePricePaid;
      if (!cost) return { fired: false, message: `${alert.ticker} has no average cost.` };
      const change = ((price - cost) / cost) * 100;
      const fired = alert.condition === "gain_percent" ? change >= alert.percent! : change <= -alert.percent!;
      return { fired, message: `${alert.ticker} is at ${price}, ${change >= 0 ? "+" : ""}${change.toFixed(2)}% against the average cost ${cost}.` };
    }
  }
}

/** The fields a scheduler tick owns; everything else stays as the user last saved it. */
function pickTickFields(alert: PriceAlert): Partial<PriceAlert> {
  const { lastPrice, lastCheckedAt, highWatermark, triggeredAt, triggeredPrice } = alert;
  return Object.fromEntries(Object.entries({ lastPrice, lastCheckedAt, highWatermark, triggeredAt, triggeredPrice }).filter(([, value]) => value !== undefined));
}

export class PriceAlerts {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  async list(environment?: TradingEnvironment): Promise<PriceAlert[]> {
    return (await this.deps.store.list<PriceAlert>("alert:"))
      .map((entry) => entry.value)
      .filter((alert) => !environment || alert.environment === environment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(input: AlertInput, now = new Date()): Promise<PriceAlert> {
    if (!credentialStatus(this.deps.config)[input.environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${input.environment.toUpperCase()} credentials are not configured`);
    if ((await this.list()).length >= MAX_ALERTS) fail("INVALID_INPUT", `At most ${MAX_ALERTS} alerts can be stored`);
    const byPrice = input.condition === "above" || input.condition === "below";
    if (byPrice && !(input.price! > 0)) fail("INVALID_INPUT", `A ${input.condition} alert needs a positive price`, { field: "price" });
    // A gain can exceed 100%; a drop or loss cannot.
    const maxPercent = input.condition === "gain_percent" ? 10_000 : 100;
    if (!byPrice && !(input.percent! > 0 && input.percent! < maxPercent))
      fail("INVALID_INPUT", `A ${input.condition} alert needs a percent above 0 and below ${maxPercent}`, { field: "percent" });
    const instrument = resolveInstrumentFromList(await this.deps.trading.instruments(input.environment), input.instrument);
    const alert: PriceAlert = {
      id: `alt_${randomToken(12)}`,
      environment: input.environment,
      ticker: instrument.ticker,
      condition: input.condition,
      ...(byPrice ? { price: input.price! } : { percent: input.percent! }),
      ...(input.note ? { note: input.note.trim().slice(0, 200) } : {}),
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(alertKey(alert.id), alert);
    return alert;
  }

  private async get(id: string): Promise<PriceAlert> {
    const alert = await this.deps.store.get<PriceAlert>(alertKey(id));
    if (!alert) fail("ALERT_NOT_FOUND", "Alert not found", { alertId: id });
    return alert;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.deps.store.delete(alertKey(id));
  }

  /** Arm a triggered alert again; a trailing alert restarts from the next price it sees. */
  async rearm(id: string): Promise<PriceAlert> {
    const { triggeredAt: _t, triggeredPrice: _p, highWatermark: _h, ...alert } = await this.get(id);
    await this.deps.store.put(alertKey(id), alert);
    return alert;
  }

  /** One scheduler tick: one positions read per environment, then every armed alert is evaluated. */
  async check(now = new Date()): Promise<AlertReport[]> {
    const armed = (await this.list()).filter((alert) => !alert.triggeredAt);
    if (!armed.length) return [];
    const credentials = credentialStatus(this.deps.config);
    const reports: AlertReport[] = [];
    const positions = new Map<TradingEnvironment, Position[] | Error>();
    for (const alert of armed) {
      if (!credentials[alert.environment]) continue;
      if (!positions.has(alert.environment)) {
        try {
          positions.set(alert.environment, await this.deps.trading.positions(alert.environment));
        } catch (error) {
          positions.set(alert.environment, new Error(asStructuredError(error).message));
        }
      }
      const held = positions.get(alert.environment)!;
      if (held instanceof Error) { reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: held.message }); continue; }
      let position: Pick<Position, "currentPrice" | "averagePricePaid"> | undefined = held.find((item) => item.instrument?.ticker.toUpperCase() === alert.ticker.toUpperCase());
      if (!position?.currentPrice) {
        // Not held: fall back to the external quote provider (price alerts only; cost-based alerts need a holding).
        const instrument = (await this.deps.trading.instruments(alert.environment)).find((item) => item.ticker.toUpperCase() === alert.ticker.toUpperCase());
        const quote = instrument && (alert.condition !== "gain_percent" && alert.condition !== "loss_percent") ? await this.deps.trading.externalQuote(instrument) : undefined;
        if (!quote) {
          reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "no_price", message: `${alert.ticker} is not held and no external quote is available.` });
          continue;
        }
        position = { currentPrice: quote.price, averagePricePaid: 0 };
      }
      const outcome = evaluateAlert(alert, position);
      const updated: PriceAlert = {
        ...alert,
        lastPrice: position.currentPrice,
        lastCheckedAt: now.toISOString(),
        ...(outcome.highWatermark === undefined ? {} : { highWatermark: outcome.highWatermark }),
        ...(outcome.fired ? { triggeredAt: now.toISOString(), triggeredPrice: position.currentPrice } : {}),
      };
      // Only write when something a reader would see changed, to keep ticks cheap.
      if (outcome.fired || updated.highWatermark !== alert.highWatermark || alert.lastPrice !== position.currentPrice) {
        // Re-read: the alert may have been deleted or re-armed while this tick fetched prices.
        const current = await this.deps.store.get<PriceAlert>(alertKey(alert.id));
        if (!current || current.createdAt !== alert.createdAt || current.triggeredAt) continue;
        await this.deps.store.put(alertKey(alert.id), { ...current, ...pickTickFields(updated) });
      }
      if (outcome.fired) {
        await this.deps.trading.recordActivity("price_alert_triggered", alert.environment, {
          ticker: alert.ticker,
          alertId: alert.id,
          price: position.currentPrice,
          outcome: `${outcome.message}${alert.note ? ` ${alert.note}` : ""}`.slice(0, 200),
        });
        reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "triggered", message: outcome.message });
      } else {
        reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: outcome.message });
      }
    }
    return reports;
  }
}
