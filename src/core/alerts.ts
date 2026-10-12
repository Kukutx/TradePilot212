// Price alerts, checked by the scheduler against the held position's price or, for instruments you
// do not hold, the external quote provider. A triggered alert writes a
// price_alert_triggered activity event (and webhook, when configured) once, then stays
// triggered until it is re-armed; a day's-move alert arms itself again on the next trading day.
// Alerts never place or cancel orders.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AlertCondition, AlertReport, PriceAlert } from "../shared/automation.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import type { DayClose } from "./today.js";
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
export function evaluateAlert(
  alert: PriceAlert,
  position: Pick<Position, "currentPrice" | "averagePricePaid">,
  /** The price's previous close, for a day's-move alert. */
  dayClose?: Extract<DayClose, { close: number }>,
): { fired: boolean; highWatermark?: number; message: string } {
  const price = position.currentPrice;
  switch (alert.condition) {
    case "day_move": {
      if (!dayClose) return { fired: false, message: `${alert.ticker} has no previous close.` };
      const change = (price / dayClose.close - 1) * 100;
      return {
        // A hair under the percent from rounding still counts.
        fired: Math.abs(change) >= alert.percent! - 1e-9,
        message: `${alert.ticker} is at ${price}, ${change >= 0 ? "+" : ""}${change.toFixed(2)}% since the close on ${dayClose.date} (${dayClose.close}; alert at ${alert.percent}% either way).`,
      };
    }
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
  const { lastPrice, lastCheckedAt, highWatermark, triggeredAt, triggeredPrice, triggeredDay, lastDayChange, lastCloseDate } = alert;
  return Object.fromEntries(Object.entries({ lastPrice, lastCheckedAt, highWatermark, triggeredAt, triggeredPrice, triggeredDay, lastDayChange, lastCloseDate }).filter(([, value]) => value !== undefined));
}

/**
 * An alert without its trigger: armed again. A day's-move alert keeps the trading day it last fired for, so it counts
 * only from the day after it, whatever a later read takes the day to be.
 */
function untriggered(alert: PriceAlert): PriceAlert {
  const { triggeredAt: _t, triggeredPrice: _p, highWatermark: _h, ...rest } = alert;
  return rest;
}

/** Whether a day's-move alert has fired for `day` or a later one: only a day after the last it fired for counts. */
const firedFor = (alert: PriceAlert, day: string | undefined) => day !== undefined && alert.triggeredDay !== undefined && day <= alert.triggeredDay;

export class PriceAlerts {
  constructor(private readonly deps: {
    config: RuntimeConfig;
    store: StateStore;
    trading: TradingService;
    /** A price's previous close (day's-move alerts); without it they wait. */
    dayClose?: (environment: TradingEnvironment, instrument: Instrument, price: number, quoted: boolean, now: Date) => Promise<DayClose>;
    /** The trading day a price is from, so an alert that fired today costs no read until the next one; none when unknown. */
    tradingDay?: (environment: TradingEnvironment, instrument: Instrument, quoted: boolean, now: Date) => Promise<string | undefined>;
  }) {}

  async list(environment?: TradingEnvironment): Promise<PriceAlert[]> {
    return (await this.deps.store.list<PriceAlert>("alert:"))
      .map((entry) => entry.value)
      .filter((alert) => !environment || alert.environment === environment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(input: AlertInput, now = new Date()): Promise<PriceAlert> {
    requireCredentials(this.deps.config, input.environment);
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

  /** Arm a triggered alert again; a trailing alert restarts from the next price it sees, a day's move from the next trading day. */
  async rearm(id: string): Promise<PriceAlert> {
    const alert = untriggered(await this.get(id));
    await this.deps.store.put(alertKey(id), alert);
    return alert;
  }

  /**
   * Whether a day's-move alert has already fired for the trading day of its price, held or quoted, from the instrument
   * list (cached) and the schedules (cached) alone: then the tick reads neither positions nor prices for it.
   */
  private async firedToday(alert: PriceAlert, now: Date): Promise<boolean> {
    if (alert.condition !== "day_move" || !alert.triggeredDay || !this.deps.tradingDay) return false;
    try {
      const listed = (await this.deps.trading.instruments(alert.environment)).find((item) => item.ticker.toUpperCase() === alert.ticker.toUpperCase());
      if (!listed) return false;
      // Held, Trading 212's price may be in the next day's pre-market; quoted, it is the regular session's.
      const days = await Promise.all([false, true].map((quoted) => this.deps.tradingDay!(alert.environment, listed, quoted, now)));
      return days.every((day) => firedFor(alert, day));
    } catch {
      return false;
    }
  }

  /**
   * One scheduler tick: one positions read per environment, then every armed alert is evaluated, and each day's-move
   * alert is armed again and evaluated once the trading day is a later one than it last fired for.
   */
  async check(now = new Date()): Promise<AlertReport[]> {
    const due = (await this.list()).filter((alert) => !alert.triggeredAt || alert.condition === "day_move");
    if (!due.length) return [];
    const credentials = credentialStatus(this.deps.config);
    const reports: AlertReport[] = [];
    const positions = new Map<TradingEnvironment, Position[] | Error>();
    const waitDay = (alert: PriceAlert) => {
      // A triggered one is quiet until the next day; one re-armed by hand says why it waits.
      if (!alert.triggeredAt) reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: `${alert.ticker} fired for ${alert.triggeredDay} already; it counts from the next trading day.` });
    };
    for (const alert of due) {
      if (!credentials[alert.environment]) continue;
      if (await this.firedToday(alert, now)) { waitDay(alert); continue; }
      if (!positions.has(alert.environment)) {
        try {
          positions.set(alert.environment, await this.deps.trading.positions(alert.environment));
        } catch (error) {
          positions.set(alert.environment, new Error(asStructuredError(error).message));
        }
      }
      const held = positions.get(alert.environment)!;
      if (held instanceof Error) { reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: held.message }); continue; }
      const holding = held.find((item) => item.instrument?.ticker.toUpperCase() === alert.ticker.toUpperCase());
      let position: Pick<Position, "currentPrice" | "averagePricePaid"> | undefined = holding;
      let instrument: Instrument | undefined;
      const quoted = !position?.currentPrice;
      try {
        // The listed instrument: a quote needs its symbol, and the day's close its exchange schedule (Trading 212's
        // holdings name neither).
        if (alert.condition !== "gain_percent" && alert.condition !== "loss_percent" && (quoted || alert.condition === "day_move")) {
          const listed = (await this.deps.trading.instruments(alert.environment)).find((item) => item.ticker.toUpperCase() === alert.ticker.toUpperCase());
          instrument = listed ? { ...(holding?.instrument ?? {}), ...listed } : holding?.instrument;
        }
        if (quoted) {
          // Not held: fall back to the external quote provider (price alerts only; cost-based alerts need a holding).
          const quote = instrument ? await this.deps.trading.externalQuote(instrument) : undefined;
          if (!quote) {
            reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "no_price", message: `${alert.ticker} is not held and no external quote is available.` });
            continue;
          }
          position = { currentPrice: quote.price, averagePricePaid: 0 };
        }
      } catch (error) {
        reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: asStructuredError(error).message });
        continue;
      }
      const price = position!.currentPrice;
      let dayClose: Extract<DayClose, { close: number }> | undefined;
      if (alert.condition === "day_move") {
        const read: DayClose = !instrument
          ? { missing: "data", problem: `Trading 212 does not list ${alert.ticker} at the moment.` }
          : this.deps.dayClose
            ? await this.deps.dayClose(alert.environment, instrument, price, quoted, now).catch((error: unknown): DayClose => ({ missing: "data", problem: asStructuredError(error).message }))
            : { missing: "provider", problem: "No quote provider is configured." };
        if ("missing" in read) {
          reports.push({ alertId: alert.id, environment: alert.environment, ticker: alert.ticker, action: "waiting", message: read.problem });
          continue;
        }
        // Fired for this trading day, or a later one, already: it counts again from the next.
        if (firedFor(alert, read.day)) { waitDay(alert); continue; }
        dayClose = read;
      }
      // A day's-move alert that fired on an earlier day starts afresh.
      const rearmed = alert.triggeredAt !== undefined;
      const base = rearmed ? untriggered(alert) : alert;
      // A session that closed before the alert was set is not its to report; its move is still recorded.
      const before = dayClose?.ended !== undefined && Date.parse(alert.createdAt) >= dayClose.ended;
      const outcome = before
        ? { fired: false, message: `${alert.ticker}'s ${dayClose!.day} session closed before the alert was set; it counts from the next one.` }
        : evaluateAlert(base, position!, dayClose);
      const updated: PriceAlert = {
        ...base,
        lastPrice: price,
        lastCheckedAt: now.toISOString(),
        ...(outcome.highWatermark === undefined ? {} : { highWatermark: outcome.highWatermark }),
        ...(dayClose ? { lastDayChange: Math.round(dayClose.change * 1e6) / 1e6, lastCloseDate: dayClose.date } : {}),
        ...(outcome.fired ? { triggeredAt: now.toISOString(), triggeredPrice: price, ...(dayClose ? { triggeredDay: dayClose.day } : {}) } : {}),
      };
      // Only write when something a reader would see changed, to keep ticks cheap.
      if (rearmed || outcome.fired || updated.highWatermark !== alert.highWatermark || alert.lastPrice !== price || alert.lastCloseDate !== updated.lastCloseDate) {
        // Re-read: the alert may have been deleted or re-armed while this tick fetched prices.
        const current = await this.deps.store.get<PriceAlert>(alertKey(alert.id));
        if (!current || current.createdAt !== alert.createdAt) continue;
        if (current.triggeredAt && !(rearmed && current.triggeredAt === alert.triggeredAt)) continue;
        await this.deps.store.put(alertKey(alert.id), { ...(rearmed ? untriggered(current) : current), ...pickTickFields(updated) });
      }
      if (outcome.fired) {
        await this.deps.trading.recordActivity("price_alert_triggered", alert.environment, {
          ticker: alert.ticker,
          alertId: alert.id,
          price,
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
