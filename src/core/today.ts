// The day's move of each holding and of the account. Trading 212's Public API gives each holding's price now but no
// previous close, so the close is the quote provider's: the last daily close before the trading day the price is from
// (the closes the holding page's chart draws, cached for half an hour). Read-only: nothing here can place an order.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { Exchange } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import type { DayMove, PortfolioToday } from "../shared/today.js";
import { asStructuredError } from "./errors.js";
import { knownFxRates, toAccountCurrency } from "./fx.js";
import { eachLimited, settleWithin, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Holdings read at once: each asks the quote provider for at most a year of closes, cached. */
const CONCURRENCY = 4;
/** A read starts no provider request after this long; the holdings left get their move on the next read. */
const READ_BUDGET_MS = 5000;
/** The wait for the day's fills; without them, shares traded on the day count from the previous close. */
const FILLS_WAIT_MS = 3000;
/** A dashboard read this recent is used as it is, so the day's moves right after the dashboard ask Trading 212 nothing new. */
const DASHBOARD_REUSE_MS = 15_000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** One event of an exchange's working schedule, as Trading 212 lists it. */
export interface ScheduleEvent { date: string; type: string }

/**
 * The trading day a price read at `now` belongs to, from the exchange's schedule: the session in progress; in the
 * pre-market or overnight session, the day that opens next; otherwise the last session (after the close, at night
 * and over a weekend the day's move is the last session's). `previous` is the session before it, when the schedule
 * reaches back that far. Undefined when the schedule has no opening at or before now to go by.
 */
export function sessionOf(events: ScheduleEvent[] | undefined, now: Date): { day: string; previous?: string } | undefined {
  const sorted = (events ?? [])
    .map((event) => ({ type: event.type, time: Date.parse(event.date) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const at = now.getTime();
  const opens = sorted.filter((event) => event.type === "OPEN");
  const lastEvent = sorted.filter((event) => event.time <= at).pop();
  const lastOpen = opens.filter((event) => event.time <= at).pop();
  const nextOpen = opens.find((event) => event.time > at);
  const early = lastEvent && (lastEvent.type === "PRE_MARKET_OPEN" || lastEvent.type === "OVERNIGHT_OPEN");
  const open = early && nextOpen ? nextOpen.time : lastOpen?.time;
  if (open === undefined) return undefined;
  const day = isoDay(open);
  const previous = opens.filter((event) => isoDay(event.time) < day).pop();
  return { day, ...(previous ? { previous: isoDay(previous.time) } : {}) };
}

/** Without a schedule: today, or the Friday before on a weekend (UTC). */
export function fallbackDay(now: Date): string {
  const weekday = now.getUTCDay();
  const back = weekday === 6 ? 1 : weekday === 0 ? 2 : 0;
  return isoDay(now.getTime() - back * DAY_MS);
}

/** A fill of the day, with its price in the instrument's currency. */
export interface DayFill { ticker: string; side: "buy" | "sell"; quantity: number; price: number; at: string }

/**
 * The day's move of one instrument from its previous close: the price now against it, and in the instrument's
 * currency the profit or loss of the shares held then, plus the day's buys from their fill price and its sells to
 * theirs, with what that is measured against.
 */
export function dayFigures(input: { quantity: number; price?: number; previous: number; fills: DayFill[] }):
  { change?: number; profitLoss?: number; base: number; bought: number; sold: number } {
  const { quantity, price, previous } = input;
  let bought = 0, sold = 0, traded = 0, spent = 0;
  for (const fill of input.fills) {
    if (fill.side === "buy") { bought += fill.quantity; traded -= fill.quantity * (fill.price - previous); spent += fill.quantity * fill.price; }
    else { sold += fill.quantity; traded += fill.quantity * (fill.price - previous); }
  }
  // The shares held at the previous close: those held now, less the day's buys, plus its sells.
  const held = Math.max(0, quantity - bought + sold);
  const profitLoss = price !== undefined ? quantity * (price - previous) + traded : quantity === 0 ? traded : undefined;
  return {
    ...(price !== undefined ? { change: round(price / previous - 1) } : {}),
    ...(profitLoss !== undefined ? { profitLoss } : {}),
    base: held * previous + spent,
    bought,
    sold,
  };
}

export interface TodayDeps {
  trading: Pick<TradingService, "getDashboard" | "instruments">;
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** Trading 212's exchanges and their working schedules (cached by the insights service). */
  schedules?: (environment: TradingEnvironment) => Promise<Exchange[]>;
  /** The account's fills since `from`. */
  fills?: (environment: TradingEnvironment, from: Date) => Promise<Array<{ ticker?: string; side?: string; quantity?: number; price?: number; filledAt?: string }>>;
  /** How long a read starts provider requests (READ_BUDGET_MS); a test sets -1 to see the holdings left for later. */
  budgetMs?: number;
}

/** The trading day of each instrument, from its exchange's schedule when Trading 212 gives one. */
export function sessionFinder(exchanges: Exchange[], now: Date) {
  const byId = new Map(exchanges.flatMap((exchange) => (exchange.workingSchedules ?? []).map((schedule) => [schedule.id, schedule.timeEvents] as const)));
  return (instrument: Pick<Instrument, "workingScheduleId"> | undefined) => {
    const events = instrument?.workingScheduleId === undefined ? undefined : byId.get(instrument.workingScheduleId);
    return sessionOf(events, now) ?? { day: fallbackDay(now) };
  };
}

const sideOf = (fill: { side?: string; quantity?: number }): "buy" | "sell" => (String(fill.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0 ? "sell" : "buy");

/** Each holding's move since its previous close, the instruments sold out on the day, and the total in the account currency. */
export async function portfolioToday(deps: TodayDeps, environment: TradingEnvironment, now = new Date()): Promise<PortfolioToday> {
  const dashboard = await deps.trading.getDashboard(environment, DASHBOARD_REUSE_MS);
  if (!dashboard.credentials[environment]) throw new Error(dashboard.warning ?? `${environment.toUpperCase()} credentials are not configured`);
  const accountCurrency = dashboard.account?.currency;
  const [instruments, exchanges] = await Promise.all([
    deps.trading.instruments(environment).catch((): Instrument[] => []),
    deps.schedules?.(environment).catch((): Exchange[] => []) ?? [],
  ]);
  const listed = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
  const session = sessionFinder(exchanges, now);
  const positions = dashboard.positions.filter((position) => position.instrument?.ticker);

  // The fills since the start of the earliest trading day, at most a few seconds.
  const days = positions.map((position) => session(listed.get(position.instrument.ticker)).day);
  const firstDay = days.reduce((first, day) => (day < first ? day : first), fallbackDay(now));
  let fillsProblem: string | undefined;
  let fills: DayFill[] = [];
  if (deps.fills) {
    const read = await settleWithin(deps.fills(environment, new Date(`${firstDay}T00:00:00Z`)).then(
      (items) => ({ items }),
      (error: unknown) => ({ problem: asStructuredError(error).message }),
    ), FILLS_WAIT_MS);
    if (!read) fillsProblem = `Trading 212's order history took more than ${FILLS_WAIT_MS / 1000} seconds.`;
    else if ("problem" in read) fillsProblem = read.problem;
    else {
      fills = read.items.flatMap((item) => (item.ticker && item.filledAt && item.price && item.price > 0 && item.quantity
        ? [{ ticker: item.ticker, side: sideOf(item), quantity: Math.abs(item.quantity), price: item.price, at: item.filledAt }]
        : []));
    }
  }

  const rates = accountCurrency ? knownFxRates(positions, accountCurrency) : {};
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);
  const held = new Set(positions.map((position) => position.instrument.ticker));
  // Instruments sold out on the day: their sells still made or lost money against the previous close.
  const soldOut = [...new Set(fills.filter((fill) => fill.side === "sell" && !held.has(fill.ticker)).map((fill) => fill.ticker))];
  type Item = { ticker: string; position?: Position };
  const items: Item[] = [...positions.map((position) => ({ ticker: position.instrument.ticker, position })), ...soldOut.map((ticker) => ({ ticker }))];

  const move = async ({ ticker, position }: Item, ask: boolean): Promise<DayMove> => {
    const instrument = listed.get(ticker) ?? (position?.instrument as Instrument | undefined);
    const currency = (instrument?.currencyCode ?? (position?.instrument as { currency?: string } | undefined)?.currency)?.toUpperCase();
    const { day, previous: lastSession } = session(listed.get(ticker));
    const dayStart = `${day}T00:00:00Z`;
    const own = fills.filter((fill) => fill.ticker === ticker && fill.at >= dayStart);
    const price = position?.currentPrice && position.currentPrice > 0 ? position.currentPrice : undefined;
    const lastFill = [...own].sort((a, b) => a.at.localeCompare(b.at)).pop();
    const identity = {
      ticker,
      ...(instrument?.name ? { name: instrument.name } : {}),
      ...(instrument?.shortName ? { shortName: instrument.shortName } : {}),
      ...(currency ? { currencyCode: currency } : {}),
      quantity: position?.quantity ?? 0,
      ...(price ? { price } : {}),
      day,
    };
    if (!ask) return { ...identity, missing: "later", problem: "Asked on the next read: this one ran out of time." };
    if (!instrument || !deps.priceHistory) return { ...identity, missing: deps.priceHistory ? "data" : "provider", problem: deps.priceHistory ? `Trading 212 does not list ${ticker} at the moment.` : "No quote provider is configured." };
    // Trading 212's price checks the provider's unit; for one sold out, the day's last fill does.
    const reference = price ?? lastFill?.price;
    const read = await deps.priceHistory({ instrument, from, ...(reference ? { last: reference } : {}) })
      .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
    if (!("prices" in read)) return { ...identity, missing: read.missing, problem: read.problem };
    const before = read.prices.points.filter((point) => point.date < day);
    const close: PricePoint | undefined = before[before.length - 1];
    const symbol = read.prices.symbol ?? ticker;
    if (!close || !(close.close > 0)) return { ...identity, missing: "data", problem: `${read.prices.source} has no close for ${symbol} before ${day}.` };
    const previousClose = { ...close, source: read.prices.source };
    if (lastSession && close.date < lastSession) {
      return { ...identity, previousClose, missing: "lag", problem: `${read.prices.source}'s closes for ${symbol} end on ${close.date}, before the last session (${lastSession}); the day's move shows once they have it.` };
    }
    const figures = dayFigures({ quantity: identity.quantity, ...(price ? { price } : {}), previous: close.close, fills: own });
    const inAccount = (amount: number) => (accountCurrency && currency ? toAccountCurrency(amount, currency, accountCurrency, rates) : undefined);
    const profitLoss = figures.profitLoss === undefined ? undefined : inAccount(figures.profitLoss);
    const base = inAccount(figures.base);
    return {
      ...identity,
      previousClose,
      ...(figures.change !== undefined ? { change: figures.change } : {}),
      ...(profitLoss !== undefined ? { profitLoss: round(profitLoss, 2) } : {}),
      ...(base !== undefined ? { base: round(base, 2) } : {}),
      ...(figures.bought ? { bought: figures.bought } : {}),
      ...(figures.sold ? { sold: figures.sold } : {}),
      ...(figures.profitLoss !== undefined && profitLoss === undefined
        ? { missing: "fx" as const, problem: `No exchange rate from ${currency ?? "the instrument's currency"} to ${accountCurrency ?? "the account currency"}: no holding in it is left to imply one.` }
        : {}),
    };
  };

  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const moves = await eachLimited(items, CONCURRENCY, deadline, (item) => move(item, true), (item) => move(item, false));
  const counted = moves.filter((item) => item.profitLoss !== undefined);
  const profitLoss = counted.reduce((sum, item) => sum + item.profitLoss!, 0);
  const base = counted.reduce((sum, item) => sum + (item.base ?? 0), 0);
  return {
    kind: "portfolio_today",
    environment,
    ...(accountCurrency ? { accountCurrency } : {}),
    moves: moves.sort((a, b) => Math.abs(b.profitLoss ?? 0) - Math.abs(a.profitLoss ?? 0)),
    ...(counted.length ? { total: { profitLoss: round(profitLoss, 2), ...(base > 0 ? { change: round(profitLoss / base) } : {}), counted: counted.length, of: moves.length } } : {}),
    ...(fillsProblem ? { fillsProblem } : {}),
    timestamp: now.toISOString(),
  };
}
