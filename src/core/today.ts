// The day's move of each holding and of the account. Trading 212's Public API gives each holding's price now but no
// previous close, so the close is the quote provider's: the last daily close before the trading day the price is from
// (the closes the holding page's chart draws, cached for half an hour). Read-only: nothing here can place an order.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { Exchange } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import type { DayMove, PortfolioToday } from "../shared/today.js";
import { asStructuredError } from "./errors.js";
import { knownFxRates, toAccountCurrency, type FxRates } from "./fx.js";
import { eachLimited, settleWithin, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Holdings read at once: each asks the quote provider for at most a year of closes, cached. */
const CONCURRENCY = 4;
/** A read starts no provider request after this long; the holdings left get their move on the next read. */
const READ_BUDGET_MS = 5000;
/** The wait for the day's fills, and for Trading 212's instrument list and schedules; without them the read goes on. */
const FILLS_WAIT_MS = 3000;
const LIST_WAIT_MS = 3000;
/**
 * A provider has the last session's close this long after it ended: before then, closes that stop short of it are
 * late; after, the last close they have is the instrument's last trade (an illiquid one skips days).
 */
const LAG_WINDOW_MS = 6 * 3_600_000;
/** Orders read for the day, newest first (Trading 212 pages them by 50). */
export const DAY_ORDER_PAGES = 2;
/** A dashboard read this recent is used as it is, so the day's moves right after the dashboard ask Trading 212 nothing new. */
const DASHBOARD_REUSE_MS = 15_000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** One event of an exchange's working schedule, as Trading 212 lists it. */
export interface ScheduleEvent { date: string; type: string }

/** The trading day a price belongs to. */
export interface Session {
  /** YYYY-MM-DD. */
  day: string;
  /** The session before it, when the schedule reaches back that far. */
  previous?: string;
  /** When the session before it closed (ms): the day's fills are the ones from then on. */
  previousClose?: number;
  /** When the session itself closed (ms), after-hours included for an instrument traded then; absent while it is on. */
  ended?: number;
}

/**
 * The trading day a price read at `now` belongs to, from the exchange's schedule: the session in progress; for an
 * instrument traded in extended hours, in the pre-market or overnight session, the day that opens next; otherwise
 * the last session (after the close, at night and over a weekend the day's move is the last session's). Undefined
 * when the schedule has no opening at or before now to go by.
 */
export function sessionOf(events: ScheduleEvent[] | undefined, now: Date, extendedHours = false): Session | undefined {
  const sorted = (events ?? [])
    .map((event) => ({ type: event.type, time: Date.parse(event.date) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  const at = now.getTime();
  const opens = sorted.filter((event) => event.type === "OPEN");
  const lastEvent = sorted.filter((event) => event.time <= at).pop();
  const lastOpen = opens.filter((event) => event.time <= at).pop();
  const nextOpen = opens.find((event) => event.time > at);
  // Trading 212's price moves in the early sessions only for an instrument traded in them.
  const early = extendedHours && lastEvent && (lastEvent.type === "PRE_MARKET_OPEN" || lastEvent.type === "OVERNIGHT_OPEN");
  const open = early && nextOpen ? nextOpen.time : lastOpen?.time;
  if (open === undefined) return undefined;
  const day = isoDay(open);
  const previous = opens.filter((event) => isoDay(event.time) < day).pop();
  const closed = sorted.filter((event) => event.type === "CLOSE" && event.time < open).pop();
  const following = opens.find((event) => event.time > open)?.time ?? Infinity;
  const ending = sorted.filter((event) => event.time > open && event.time < following && (event.type === "CLOSE" || (extendedHours && event.type === "AFTER_HOURS_CLOSE"))).pop();
  return {
    day,
    ...(previous ? { previous: isoDay(previous.time) } : {}),
    ...(closed ? { previousClose: closed.time } : {}),
    ...(ending && ending.time <= at ? { ended: ending.time } : {}),
  };
}

/** Without a schedule: today, or the Friday before on a weekend (UTC). */
export function fallbackDay(now: Date): string {
  const weekday = now.getUTCDay();
  const back = weekday === 6 ? 1 : weekday === 0 ? 2 : 0;
  return isoDay(now.getTime() - back * DAY_MS);
}

/** A fill of the day, with its price in the instrument's currency. */
export interface DayFill { ticker: string; side: "buy" | "sell"; quantity: number; price: number; at: string }

/** A fill price a hundred times off the previous close is in pence for pounds or pounds for pence: it is brought to the close's unit. */
export function inCloseUnit(price: number, close: number): number {
  const ratio = price / close;
  return ratio > 30 ? price / 100 : ratio < 1 / 30 ? price * 100 : price;
}

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
  /** The account's fills since `from`, and whether the read stopped before reaching it. */
  fills?: (environment: TradingEnvironment, from: Date) => Promise<{
    fills: Array<{ ticker?: string; side?: string; quantity?: number; price?: number; filledAt?: string }>;
    truncated?: boolean;
  }>;
  /**
   * Previous closes known to be final (the last session's, read after it), by instrument and day: the day's later
   * reads ask the quote provider nothing for them. Kept by the caller across reads.
   */
  closes?: Map<string, PricePoint & { source: string }>;
  /** How long a read starts provider requests (READ_BUDGET_MS); a test sets -1 to see the holdings left for later. */
  budgetMs?: number;
}

/** The trading day of each instrument, from its exchange's schedule when Trading 212 gives one. */
export function sessionFinder(exchanges: Exchange[], now: Date) {
  const byId = new Map(exchanges.flatMap((exchange) => (exchange.workingSchedules ?? []).map((schedule) => [schedule.id, schedule.timeEvents] as const)));
  return (instrument: Pick<Instrument, "workingScheduleId" | "extendedHours"> | undefined): Session => {
    const events = instrument?.workingScheduleId === undefined ? undefined : byId.get(instrument.workingScheduleId);
    return sessionOf(events, now, instrument?.extendedHours === true) ?? { day: fallbackDay(now) };
  };
}

/** When the day's fills start: the previous session's close, else the start of the day (UTC). */
const fillsFrom = (session: Session) => session.previousClose ?? Date.parse(`${session.day}T00:00:00Z`);

const sideOf = (fill: { side?: string; quantity?: number }): "buy" | "sell" => (String(fill.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0 ? "sell" : "buy");

/** What one instrument's day is read against. */
export interface DayContext {
  environment: TradingEnvironment;
  now: Date;
  /** How far back the closes are read (shared with the holding page's chart, so one cached read serves both). */
  from: Date;
  accountCurrency?: string;
  /** Exchange rates implied by Trading 212's valuation of the holdings. */
  rates: FxRates;
}

/** One instrument: held (`position`), sold out on the day, or only priced by a quote (`price`). */
export interface DayInput {
  ticker: string;
  instrument?: Instrument;
  position?: Position;
  /** The price now when Trading 212 has none for it (not held): a quote's. */
  price?: number;
  session: Session;
  /** Its fills since its previous close. */
  fills: DayFill[];
}

export function dayIdentity(input: DayInput) {
  const { ticker, instrument, position, session } = input;
  const currency = (instrument?.currencyCode ?? (position?.instrument as { currency?: string } | undefined)?.currency)?.toUpperCase();
  const price = position?.currentPrice && position.currentPrice > 0 ? position.currentPrice : input.price && input.price > 0 ? input.price : undefined;
  return {
    ticker,
    ...(instrument?.name ? { name: instrument.name } : {}),
    ...(instrument?.shortName ? { shortName: instrument.shortName } : {}),
    ...(currency ? { currencyCode: currency } : {}),
    quantity: position?.quantity ?? 0,
    ...(price ? { price } : {}),
    day: session.day,
  };
}

/** One instrument's move since its previous close, and what it made or lost on the day in the account currency. */
export async function dayMove(deps: Pick<TodayDeps, "priceHistory" | "closes">, context: DayContext, input: DayInput): Promise<DayMove> {
  const { environment, now, from, accountCurrency, rates } = context;
  const { ticker, instrument, session, fills: own } = input;
  const identity = dayIdentity(input);
  const { day, previous: lastSession, previousClose: lastClosed } = session;
  const price = identity.price;
  const currency = identity.currencyCode;
  if (!instrument || !deps.priceHistory) return { ...identity, missing: deps.priceHistory ? "data" : "provider", problem: deps.priceHistory ? `Trading 212 does not list ${ticker} at the moment.` : "No quote provider is configured." };
  const lastFill = [...own].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();
  const key = `${environment}:${ticker}:${day}`;
  let previousClose = deps.closes?.get(key);
  if (!previousClose) {
    // Trading 212's price checks the provider's unit; for one sold out, the day's last fill does.
    const reference = price ?? lastFill?.price;
    const read = await deps.priceHistory({ instrument, from, ...(reference ? { last: reference } : {}) })
      .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
    if (!("prices" in read)) return { ...identity, missing: read.missing, problem: read.problem };
    const before = read.prices.points.filter((point) => point.date < day);
    const close: PricePoint | undefined = before[before.length - 1];
    const symbol = read.prices.symbol ?? ticker;
    if (!close || !(close.close > 0)) return { ...identity, missing: "data", problem: `${read.prices.source} has no close for ${symbol} before ${day}.` };
    previousClose = { ...close, source: read.prices.source };
    if (lastSession && close.date < lastSession && lastClosed !== undefined && now.getTime() - lastClosed < LAG_WINDOW_MS) {
      return { ...identity, previousClose, missing: "lag", problem: `${read.prices.source}'s closes for ${symbol} end on ${close.date}, before the last session (${lastSession}); the day's move shows once they have it.` };
    }
    // The last session's close, or the last one once the provider has had time to add it, will not change today.
    if (deps.closes && lastSession && (close.date === lastSession || (lastClosed !== undefined && now.getTime() - lastClosed >= LAG_WINDOW_MS))) {
      if (deps.closes.size > 1000) deps.closes.clear();
      deps.closes.set(key, previousClose);
    }
  }
  const previous = previousClose.close;
  const figures = dayFigures({
    quantity: identity.quantity,
    ...(price ? { price } : {}),
    previous,
    fills: own.map((fill) => ({ ...fill, price: inCloseUnit(fill.price, previous) })),
  });
  // Neither held nor traded on the day: only the change.
  const owned = identity.quantity > 0 || own.length > 0;
  const inAccount = (amount: number) => (accountCurrency && currency ? toAccountCurrency(amount, currency, accountCurrency, rates) : undefined);
  const profitLoss = !owned || figures.profitLoss === undefined ? undefined : inAccount(figures.profitLoss);
  const base = owned ? inAccount(figures.base) : undefined;
  return {
    ...identity,
    previousClose,
    ...(figures.change !== undefined ? { change: figures.change } : {}),
    ...(profitLoss !== undefined ? { profitLoss: round(profitLoss, 2) } : {}),
    ...(base !== undefined ? { base: round(base, 2) } : {}),
    ...(figures.bought ? { bought: figures.bought } : {}),
    ...(figures.sold ? { sold: figures.sold } : {}),
    ...(owned && figures.profitLoss !== undefined && profitLoss === undefined
      ? { missing: "fx" as const, problem: `No exchange rate from ${currency ?? "the instrument's currency"} to ${accountCurrency ?? "the account currency"}: no holding in it is left to imply one.` }
      : {}),
  };
}

/**
 * The trading day an instrument's price is from: a quote's is the regular session's, Trading 212's may be extended
 * hours'. None when the instrument names a schedule that could not be read: a guessed day could be a day off.
 */
export async function daySessionOf(
  deps: Pick<TodayDeps, "schedules">,
  environment: TradingEnvironment,
  instrument: Pick<Instrument, "workingScheduleId" | "extendedHours">,
  quoted: boolean,
  now = new Date(),
): Promise<Session | undefined> {
  const exchanges = (deps.schedules ? await settleWithin(deps.schedules(environment).catch((): Exchange[] => []), LIST_WAIT_MS) : undefined) ?? [];
  const id = instrument.workingScheduleId;
  if (id !== undefined && !exchanges.some((exchange) => (exchange.workingSchedules ?? []).some((schedule) => schedule.id === id))) return undefined;
  return sessionFinder(exchanges, now)(quoted ? { ...instrument, extendedHours: false } : instrument);
}

/** A price against its previous close: the trading day, the close and its date, and the change. */
export type DayClose = { day: string; close: number; date: string; change: number; ended?: number } | { missing: DayMove["missing"]; problem: string };

/**
 * One price's change from its previous close, as the dashboard's day works it out: from Trading 212's price of a
 * holding (which moves in the pre-market for an instrument traded then) or from a quote (which does not).
 */
export async function dayCloseOf(
  deps: Pick<TodayDeps, "priceHistory" | "closes" | "schedules"> & {
    /** Closes read for a quote, kept apart: they are checked against the provider's own price, not Trading 212's. */
    quotedCloses?: TodayDeps["closes"];
  },
  environment: TradingEnvironment,
  instrument: Instrument,
  price: number,
  quoted: boolean,
  now = new Date(),
): Promise<DayClose> {
  const session = await daySessionOf(deps, environment, instrument, quoted, now);
  if (!session) return { missing: "data", problem: `Trading 212's exchange schedules could not be read, so the trading day of ${instrument.ticker}'s price is not known.` };
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);
  const closes = quoted ? deps.quotedCloses : deps.closes;
  const move = await dayMove({ ...(deps.priceHistory ? { priceHistory: deps.priceHistory } : {}), ...(closes ? { closes } : {}) }, { environment, now, from, rates: {} }, { ticker: instrument.ticker, instrument, price, session, fills: [] });
  if (!move.previousClose || move.change === undefined) return { missing: move.missing ?? "data", problem: move.problem ?? `No previous close for ${instrument.ticker}.` };
  return { day: session.day, close: move.previousClose.close, date: move.previousClose.date, change: move.change, ...(session.ended === undefined ? {} : { ended: session.ended }) };
}

/** An instrument's fills since its session's previous close, from fill records as Trading 212's history gives them. */
export function fillsOfDay(items: Array<{ ticker?: string; side?: string; quantity?: number; price?: number; filledAt?: string }>, ticker: string, session: Session): DayFill[] {
  const start = fillsFrom(session);
  return dayFillsOf(items).filter((fill) => fill.ticker === ticker && Date.parse(fill.at) >= start);
}

const dayFillsOf = (items: Array<{ ticker?: string; side?: string; quantity?: number; price?: number; filledAt?: string }>): DayFill[] =>
  items.flatMap((item) => (item.ticker && item.filledAt && Number.isFinite(Date.parse(item.filledAt)) && item.price && item.price > 0 && item.quantity
    ? [{ ticker: item.ticker, side: sideOf(item), quantity: Math.abs(item.quantity), price: item.price, at: item.filledAt }]
    : []));

/** Each holding's move since its previous close, the instruments sold out on the day, and the total in the account currency. */
export async function portfolioToday(deps: TodayDeps, environment: TradingEnvironment, now = new Date()): Promise<PortfolioToday> {
  const dashboard = await deps.trading.getDashboard(environment, DASHBOARD_REUSE_MS);
  if (!dashboard.credentials[environment]) throw new Error(dashboard.warning ?? `${environment.toUpperCase()} credentials are not configured`);
  const accountCurrency = dashboard.account?.currency;
  // The instrument list (cached ten minutes) and the schedules, at most a few seconds each: without them each
  // holding's day is today's, or Friday's on a weekend.
  const [instruments, exchanges] = await Promise.all([
    settleWithin(deps.trading.instruments(environment).catch((): Instrument[] => []), LIST_WAIT_MS),
    deps.schedules ? settleWithin(deps.schedules(environment).catch((): Exchange[] => []), LIST_WAIT_MS) : undefined,
  ]);
  const listed = new Map((instruments ?? []).map((instrument) => [instrument.ticker, instrument]));
  const finder = sessionFinder(exchanges ?? [], now);
  const session = (ticker: string) => finder(listed.get(ticker));
  const positions = dashboard.positions.filter((position) => position.instrument?.ticker);

  // The fills since the earliest previous close, at most a few seconds.
  const earliest = positions.reduce((first, position) => Math.min(first, fillsFrom(session(position.instrument.ticker))), fillsFrom({ day: fallbackDay(now) }));
  let fillsProblem: string | undefined;
  let fills: DayFill[] = [];
  if (deps.fills) {
    const read = await settleWithin(deps.fills(environment, new Date(earliest))
      .catch((error: unknown) => ({ problem: asStructuredError(error).message })), FILLS_WAIT_MS);
    if (!read) fillsProblem = `Trading 212's order history took more than ${FILLS_WAIT_MS / 1000} seconds.`;
    else if ("problem" in read) fillsProblem = read.problem;
    else {
      if (read.truncated) fillsProblem = `The day has more orders than one read covers (${DAY_ORDER_PAGES * 50}); the oldest of them are left out.`;
      fills = dayFillsOf(read.fills);
    }
  }
  /** An instrument's fills since its previous close. */
  const dayFills = (ticker: string) => {
    const start = fillsFrom(session(ticker));
    return fills.filter((fill) => fill.ticker === ticker && Date.parse(fill.at) >= start);
  };

  const rates = accountCurrency ? knownFxRates(positions, accountCurrency) : {};
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);
  const held = new Set(positions.map((position) => position.instrument.ticker));
  // Instruments sold out on their day: their sells still made or lost money against the previous close.
  const soldOut = [...new Set(fills.filter((fill) => !held.has(fill.ticker)).map((fill) => fill.ticker))]
    .filter((ticker) => dayFills(ticker).some((fill) => fill.side === "sell"));
  type Item = { ticker: string; position?: Position };
  const items: Item[] = [...positions.map((position) => ({ ticker: position.instrument.ticker, position })), ...soldOut.map((ticker) => ({ ticker }))];

  const context: DayContext = { environment, now, from, ...(accountCurrency ? { accountCurrency } : {}), rates };
  const move = ({ ticker, position }: Item, ask: boolean): Promise<DayMove> => {
    const input: DayInput = {
      ticker,
      ...(listed.get(ticker) ?? position?.instrument ? { instrument: listed.get(ticker) ?? (position!.instrument as Instrument) } : {}),
      ...(position ? { position } : {}),
      session: session(ticker),
      fills: dayFills(ticker),
    };
    return ask ? dayMove(deps, context, input) : Promise.resolve({ ...dayIdentity(input), missing: "later", problem: "Asked on the next read: this one ran out of time." });
  };

  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const moves = await eachLimited(items, CONCURRENCY, deadline, (item) => move(item, true), (item) => move(item, false));
  const counted = moves.filter((item) => item.profitLoss !== undefined);
  const profitLoss = counted.reduce((sum, item) => sum + item.profitLoss!, 0);
  const base = counted.reduce((sum, item) => sum + (item.base ?? 0), 0);
  // When each day's sessions all closed; a day with one still on (or unknown) is left out.
  const closings = new Map<string, number | null>();
  for (const { ticker } of items) {
    const { day, ended } = session(ticker);
    const before = closings.get(day);
    closings.set(day, before === null || ended === undefined ? null : Math.max(before ?? 0, ended));
  }
  const ended = Object.fromEntries([...closings].filter((entry): entry is [string, number] => entry[1] !== null));
  const invested = dashboard.account?.investments?.currentValue;
  return {
    kind: "portfolio_today",
    environment,
    ...(accountCurrency ? { accountCurrency } : {}),
    moves: moves.sort((a, b) => Math.abs(b.profitLoss ?? 0) - Math.abs(a.profitLoss ?? 0)),
    ...(counted.length ? { total: { profitLoss: round(profitLoss, 2), ...(base > 0 ? { change: round(profitLoss / base) } : {}), counted: counted.length, of: moves.length } } : {}),
    ...(fillsProblem ? { fillsProblem } : {}),
    ...(invested !== undefined && Number.isFinite(invested) ? { invested } : {}),
    ...(Object.keys(ended).length ? { ended } : {}),
    timestamp: now.toISOString(),
  };
}
