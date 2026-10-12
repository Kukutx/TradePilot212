// The watchlist: instruments the user follows, held or not, kept by TradePilot per account. Reading it gathers, for
// each, the price now (Trading 212's for a holding, the quote provider's otherwise), the daily closes behind its
// changes and sparkline, and the open orders and armed alerts waiting on it. It never places orders.

import type { PriceAlert } from "../shared/automation.js";
import type { Instrument, PendingOrder, Position, TradingEnvironment } from "../shared/contracts.js";
import type { Exchange } from "../shared/history.js";
import { PRICE_RANGES, pricesIn, rangeCovered, type PricePoint } from "../shared/prices.js";
import { MAX_WATCH_NOTE, MAX_WATCHLIST, type WatchItem, type WatchLevel, type WatchlistView, type WatchPeriod, type WatchRow } from "../shared/watchlist.js";
import type { PriceAlerts } from "./alerts.js";
import { requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import { eachLimited, quoteUnitProblem, settleWithin, unitReference, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import type { StateStore } from "./state-store.js";
import { sessionFinder } from "./today.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Rows read at once: each asks the quote provider for at most a price and a year of closes, both cached. */
const CONCURRENCY = 4;
/** A read starts no provider request after this long; the rows left show what Trading 212 knows and wait for the next. */
const READ_BUDGET_MS = 5000;
/** The wait for the quote provider's price of an instrument not held; a slower one is left out. */
const QUOTE_WAIT_MS = 3000;
/** The sparkline's days: about three months. */
const SPARK_DAYS = 92;
const PERIOD_DAYS = Object.fromEntries(PRICE_RANGES) as Record<"1m" | "3m" | "1y", number>;

/** Where an instrument's watchlist entry is stored. */
export const watchKey = (environment: TradingEnvironment, ticker: string) => `watch:${environment}:${ticker}`;
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export class Watchlist {
  /** Changes run one at a time, so two adds at once cannot both pass the cap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: Pick<TradingService, "instruments" | "positions" | "externalQuote"> }) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The entry for an instrument: by its exact ticker first, so one Trading 212 no longer lists still matches. */
  private async find(environment: TradingEnvironment, instrument: string): Promise<{ ticker: string; item?: WatchItem }> {
    const wanted = instrument.trim().toUpperCase();
    const item = (await this.list(environment)).find((entry) => entry.ticker.toUpperCase() === wanted);
    if (item) return { ticker: item.ticker, item };
    const { ticker } = resolveInstrumentFromList(await this.deps.trading.instruments(environment), instrument);
    return { ticker, item: await this.get(environment, ticker) };
  }

  /** In the order they were added. */
  async list(environment: TradingEnvironment): Promise<WatchItem[]> {
    return (await this.deps.store.list<WatchItem>(`watch:${environment}:`))
      .map((entry) => entry.value)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.ticker.localeCompare(b.ticker));
  }

  get(environment: TradingEnvironment, ticker: string): Promise<WatchItem | undefined> {
    return this.deps.store.get<WatchItem>(watchKey(environment, ticker));
  }

  /**
   * Add an instrument with the price it is at now, or, when it is on the list already, change its note (an empty
   * note clears it). Resolves names and symbols like an order does.
   */
  async add(environment: TradingEnvironment, instrument: string, note?: string, now = new Date()): Promise<{ item: WatchItem; added: boolean }> {
    requireCredentials(this.deps.config, environment);
    return this.serial(async () => {
      const found = await this.find(environment, instrument);
      if (found.item) return { item: note === undefined ? found.item : await this.writeNote(found.item, note), added: false };
      const instruments = await this.deps.trading.instruments(environment);
      const resolved = instruments.find((entry) => entry.ticker === found.ticker) ?? resolveInstrumentFromList(instruments, found.ticker);
      if ((await this.list(environment)).length >= MAX_WATCHLIST) fail("INVALID_INPUT", `A watchlist keeps at most ${MAX_WATCHLIST} instruments; remove one first`, { field: "instrument" });
      // The price it is added at: Trading 212's for a holding, else the quote provider's when it answers in time.
      const positions = await this.deps.trading.positions(environment).catch((): Position[] => []);
      const held = positions.find((position) => position.instrument?.ticker === resolved.ticker)?.currentPrice;
      const price = held && held > 0 ? held : (await settleWithin(this.deps.trading.externalQuote(resolved).catch(() => undefined), QUOTE_WAIT_MS))?.price;
      const text = note?.trim().slice(0, MAX_WATCH_NOTE);
      const item: WatchItem = {
        environment,
        ticker: resolved.ticker,
        ...(text ? { note: text } : {}),
        addedAt: now.toISOString(),
        ...(price && price > 0 ? { addedPrice: price } : {}),
      };
      await this.deps.store.put(watchKey(environment, item.ticker), item);
      return { item, added: true };
    });
  }

  /** Change the note of an instrument on the list (an empty note clears it); one not on the list is not added. */
  note(environment: TradingEnvironment, instrument: string, note: string): Promise<WatchItem> {
    return this.serial(async () => {
      const found = await this.find(environment, instrument);
      if (!found.item) fail("INVALID_INPUT", `${instrument} is not on the watchlist`, { field: "instrument" });
      return this.writeNote(found.item, note);
    });
  }

  private async writeNote(existing: WatchItem, note: string): Promise<WatchItem> {
    const text = note.trim().slice(0, MAX_WATCH_NOTE);
    const { note: _old, ...rest } = existing;
    const item: WatchItem = { ...rest, ...(text ? { note: text } : {}) };
    await this.deps.store.put(watchKey(existing.environment, existing.ticker), item);
    return item;
  }

  /** Take an instrument off the list: by its exact ticker first, so one Trading 212 no longer lists can still go. */
  remove(environment: TradingEnvironment, instrument: string): Promise<WatchItem> {
    return this.serial(async () => {
      const { item } = await this.find(environment, instrument);
      if (!item) fail("INVALID_INPUT", `${instrument} is not on the watchlist`, { field: "instrument" });
      await this.deps.store.delete(watchKey(environment, item.ticker));
      return item;
    });
  }
}

/** The open orders on a ticker (each at its trigger: a stop-limit's stop) and its armed above/below alerts. */
export function watchLevels(ticker: string, orders: PendingOrder[], alerts: PriceAlert[]): WatchLevel[] {
  const levels: WatchLevel[] = [];
  for (const order of orders) {
    if (order.ticker !== ticker) continue;
    const stop = typeof order.stopPrice === "number" && order.stopPrice > 0 ? order.stopPrice : undefined;
    const price = stop ?? (typeof order.limitPrice === "number" && order.limitPrice > 0 ? order.limitPrice : undefined);
    if (price === undefined) continue;
    const sell = String(order.side ?? "").toUpperCase() === "SELL" || (typeof order.quantity === "number" && order.quantity < 0);
    levels.push({ kind: stop ? "stop" : "limit", side: sell ? "sell" : "buy", price });
  }
  for (const alert of alerts) {
    if (alert.ticker !== ticker || alert.triggeredAt || (alert.condition !== "above" && alert.condition !== "below") || !(alert.price! > 0)) continue;
    levels.push({ kind: "alert", condition: alert.condition, price: alert.price! });
  }
  return levels;
}

export interface WatchCloses {
  price: number;
  /** The day the price is from, YYYY-MM-DD: the trading day of a live price, the close's day for a close. */
  day: string;
  points: PricePoint[];
}

/** The changes, range and sparkline of a row, from its closes and its price now. */
export function watchFigures({ price, day, points }: WatchCloses): Pick<WatchRow, "changes" | "high" | "low" | "rangeFrom" | "spark"> {
  const changes: Partial<Record<WatchPeriod, number>> = {};
  // The closes before the price's own day; the price stands in for that day's close.
  const before = points.filter((point) => point.date < day);
  const previous = before[before.length - 1];
  if (previous) changes["1d"] = round(price / previous.close - 1);
  for (const key of ["1m", "3m", "1y"] as const) {
    const days = PERIOD_DAYS[key];
    const start = pricesIn(points, days)[0];
    if (start && rangeCovered(points, days)) changes[key] = round(price / start.close - 1);
  }
  if (!before.length) return { changes };
  const recent = pricesIn(before, SPARK_DAYS);
  const closes = [...before.map((point) => point.close), price];
  return {
    changes,
    high: Math.max(...closes),
    low: Math.min(...closes),
    // Closes short of a year (a recent listing, or a provider's 100 days) give the range from their first day.
    ...(rangeCovered(points, PERIOD_DAYS["1y"]) ? {} : { rangeFrom: before[0]!.date }),
    spark: { from: recent[0]!.date, closes: [...recent.map((point) => point.close), price] },
  };
}

export interface WatchlistDeps {
  watchlist: Watchlist;
  trading: TradingService;
  alerts: PriceAlerts;
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** Trading 212's exchanges and their working schedules: the trading day a holding's price is from. */
  schedules?: (environment: TradingEnvironment) => Promise<Exchange[]>;
  /** How long a read starts provider requests (READ_BUDGET_MS); a test sets -1 to see the rows left for later. */
  budgetMs?: number;
}

/** The watchlist with each row's price, changes, range, sparkline and the levels around it. */
export async function watchlistView(deps: WatchlistDeps, environment: TradingEnvironment, now = new Date()): Promise<WatchlistView> {
  const dashboard = await deps.trading.getDashboard(environment);
  if (!dashboard.credentials[environment]) throw new Error(dashboard.warning ?? `${environment.toUpperCase()} credentials are not configured`);
  const [items, instruments, alerts, exchanges] = await Promise.all([
    deps.watchlist.list(environment),
    deps.trading.instruments(environment).catch((): Instrument[] => []),
    deps.alerts.list(environment).catch((): PriceAlert[] => []),
    deps.schedules?.(environment).catch((): Exchange[] => []) ?? [],
  ]);
  const session = sessionFinder(exchanges, now);
  const listed = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);

  const row = async (item: WatchItem, ask: boolean): Promise<WatchRow> => {
    const instrument = listed.get(item.ticker);
    const position = dashboard.positions.find((entry) => entry.instrument?.ticker === item.ticker);
    const brokerPrice = position?.currentPrice && position.currentPrice > 0 ? position.currentPrice : undefined;
    const levels = watchLevels(item.ticker, dashboard.orders, alerts);
    let price = brokerPrice;
    let priceSource = brokerPrice ? "broker" : undefined;
    let priceAt = brokerPrice ? dashboard.timestamp : undefined;
    let points: PricePoint[] | undefined;
    let missing: WatchRow["pricesMissing"];
    let problem: string | undefined;
    if (!instrument) {
      missing = "data";
      problem = `Trading 212 does not list ${item.ticker} at the moment.`;
    } else if (!ask) {
      missing = "later";
      problem = "Asked on the next read: this one ran out of time.";
    } else {
      const quote = brokerPrice ? Promise.resolve(undefined) : settleWithin(deps.trading.externalQuote(instrument).catch(() => undefined), QUOTE_WAIT_MS);
      const read = deps.priceHistory?.({
        instrument,
        from,
        ...(brokerPrice ? { last: brokerPrice } : { quote: quote.then((quoted) => quoted?.price) }),
        levels: Promise.resolve(levels.map((level) => level.price)),
      }).catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
      const [quoted, history] = await Promise.all([quote, read]);
      if (history && "prices" in history) points = history.prices.points;
      else if (history) { missing = history.missing; problem = history.problem; }
      // The quote comes from the closes' mapping: in another unit when they are, and checked the same way when they
      // did not come (late, or none on the plan).
      const unitProblem = quoted && !brokerPrice ? quoteUnitProblem(quoted, item.ticker, unitReference(undefined, levels.map((level) => level.price), [])) : undefined;
      if (unitProblem && !points && missing !== "unit") { missing = "unit"; problem = unitProblem; }
      if (!price && quoted && quoted.price > 0 && missing !== "unit" && !unitProblem) { price = quoted.price; priceSource = quoted.source; priceAt = quoted.asOf; }
      const last = points?.[points.length - 1];
      if (!price && last) { price = last.close; priceSource = "close"; priceAt = last.date; }
    }
    // The day the price is from: Trading 212's is the session in progress or the last one (a weekend, or before the
    // market opens), and a quote's is its own.
    const day = priceSource === "broker" || !priceAt ? session(instrument).day : priceAt.slice(0, 10);
    const figures = price && points?.length ? watchFigures({ price, day, points }) : { changes: {} };
    // A price added in another unit (a fund quoted in pounds, held in pence) gives no "since added".
    const ratio = price && item.addedPrice ? price / item.addedPrice : undefined;
    return {
      ticker: item.ticker,
      ...(instrument?.name ? { name: instrument.name } : position?.instrument?.name ? { name: position.instrument.name } : {}),
      ...(instrument?.shortName ? { shortName: instrument.shortName } : {}),
      ...(instrument?.currencyCode ? { currencyCode: instrument.currencyCode } : {}),
      ...(instrument?.type ? { type: instrument.type } : {}),
      ...(item.note ? { note: item.note } : {}),
      addedAt: item.addedAt,
      ...(item.addedPrice ? { addedPrice: item.addedPrice } : {}),
      ...(position ? { held: { quantity: position.quantity, averagePrice: position.averagePricePaid } } : {}),
      ...(price ? { price, priceSource: priceSource!, priceAt: priceAt! } : {}),
      ...(ratio !== undefined && ratio < 10 && ratio > 0.1 ? { sinceAdded: round(ratio - 1) } : {}),
      ...figures,
      levels: levels
        .map((level) => (price ? { ...level, distance: round(level.price / price - 1) } : level))
        .sort((a, b) => Math.abs(a.distance ?? Infinity) - Math.abs(b.distance ?? Infinity)),
      ...(missing ? { pricesMissing: missing, pricesProblem: problem! } : {}),
    };
  };

  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const rows = await eachLimited(items, CONCURRENCY, deadline, (item) => row(item, true), (item) => row(item, false));
  return {
    kind: "watchlist",
    environment,
    credentials: dashboard.credentials,
    ...(dashboard.account?.currency ? { accountCurrency: dashboard.account.currency } : {}),
    items: rows,
    timestamp: now.toISOString(),
  };
}
