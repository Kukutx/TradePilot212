// The detail of one instrument in one account, gathered from the services that already read each part.

import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import type { Exchange, MarketStatus } from "../shared/history.js";
import type { HoldingDetail } from "../shared/holding.js";
import type { JournalEntry } from "../shared/journal.js";
import { isSplitType, readSplits } from "../shared/splits.js";
import type { PriceAlerts } from "./alerts.js";
import { marketStatus } from "./analytics.js";
import { addMonths, dividendSchedule, expectedPayments, monthStart, scheduleStart } from "./dividends.js";
import { asStructuredError } from "./errors.js";
import { knownFxRates } from "./fx.js";
import type { InsightsService } from "./insights-service.js";
import type { TradeJournal } from "./journal.js";
import { quoteUnitProblem, settleWithin, unitReference, type PriceAnchor, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import type { TargetAllocations } from "./targets.js";
import { dayMove, fillsOfDay, sessionFinder, type TodayDeps } from "./today.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import type { Watchlist } from "./watchlist.js";

const DAY_MS = 86_400_000;
/** Fills and dividends listed; the dividend total covers the whole window. */
const MAX_FILLS = 20;
/** Fills the price chart marks: the listed ones and, with only what a mark needs, older ones up to this many. */
const MAX_CHART_FILLS = 200;
const MAX_DIVIDENDS = 12;
/** The newest journal notes listed, plus any on a listed fill. */
const MAX_NOTES = 20;
/** Two pages of each history is at most four requests, well inside Trading 212's limits even with a few views open. */
const HISTORY_PAGES = 2;
/** The page waits this long for the quote provider's price of an instrument not held; a slower one is left out. */
const QUOTE_WAIT_MS = 3000;

/** The market session, or none when the schedule cannot be read. */
function marketStatusOf(instrument: Instrument, exchanges: Exchange[], now: Date): MarketStatus | undefined {
  try { return marketStatus(instrument, exchanges, now); } catch { return undefined; }
}

export interface HoldingDeps {
  trading: TradingService;
  insights: InsightsService;
  alerts: PriceAlerts;
  journal: TradeJournal;
  targets: TargetAllocations;
  /** Daily closes for the price chart; without it the page has none. */
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** Whether the instrument is on the watchlist; without it the page does not say. */
  watchlist?: Pick<Watchlist, "get">;
  /** Previous closes kept for the day, shared with the dashboard's day. */
  closes?: TodayDeps["closes"];
}

/**
 * One instrument: the position (if held), its share of the account and saved target, open orders,
 * price alerts, journal notes, market session, the last 12 months of fills and of daily closes, and the dividends since the first day of this month a year ago.
 * A failed history or price read leaves the rest in place and says why.
 */
export async function holdingDetail(deps: HoldingDeps, environment: TradingEnvironment, query: string, now = new Date()): Promise<HoldingDetail> {
  const dashboard = await deps.trading.getDashboard(environment);
  if (!dashboard.credentials[environment]) throw new Error(dashboard.warning ?? `${environment.toUpperCase()} credentials are not configured`);
  const wanted = query.trim().toUpperCase();
  // A held ticker needs no instrument list; anything else resolves like an order does.
  const held = dashboard.positions.find((position) => position.instrument.ticker.toUpperCase() === wanted);
  const listed = held ? undefined : resolveInstrumentFromList(await deps.trading.instruments(environment), query);
  const ticker = held?.instrument.ticker ?? listed!.ticker;
  const position = held ?? dashboard.positions.find((item) => item.instrument.ticker === ticker);
  const total = dashboard.account?.totalValue;
  const value = (position?.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
  const window = { from: new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS), to: now };
  // Dividends from the first day of this month a year ago, so last year's payment due again this month is seen.
  const dividendWindow = { from: new Date(Math.min(window.from.getTime(), scheduleStart(now.getTime()))), to: now };
  const historyRead = Promise.all([
    deps.insights.tradeHistory(environment, window, ticker, MAX_CHART_FILLS, HISTORY_PAGES),
    deps.insights.cashHistory(environment, dividendWindow, { ticker, types: ["DIVIDEND"], limit: MAX_DIVIDENDS, maxPages: HISTORY_PAGES }),
  ]).catch((error: unknown) => asStructuredError(error));
  const fills = historyRead.then((read): PriceAnchor[] => (Array.isArray(read)
    ? read[0].fills.flatMap((fill) => (fill.filledAt && fill.price ? [{ at: fill.filledAt, price: fill.price }] : []))
    : []));
  // Trading 212's holdings name an instrument without its exchange schedule: the instrument list has it. The history
  // read below waits for the same list (one shared request, cached ten minutes), so this adds no wait of its own.
  const subjectRead: Promise<Instrument> = listed
    ? Promise.resolve(listed)
    : deps.trading.instruments(environment).catch((): Instrument[] => [])
      .then((list) => ({ ...position!.instrument, ...list.find((item) => item.ticker === ticker) }));
  const subject = listed ?? position!.instrument;
  // Not held: Trading 212 has no price for it, so the quote provider's, when it answers in time.
  const quoteRead = position?.currentPrice ? Promise.resolve(undefined) : settleWithin(deps.trading.externalQuote(subject).catch(() => undefined), QUOTE_WAIT_MS);
  const alertsRead = deps.alerts.list(environment);
  // Where the open orders and armed above/below alerts sit: the unit check's reference for an instrument not held.
  const levels = alertsRead.catch(() => []).then((list) => [
    ...dashboard.orders.filter((order) => order.ticker === ticker).flatMap((order) => [order.stopPrice, order.limitPrice]),
    ...list.filter((alert) => alert.ticker === ticker && !alert.triggeredAt && (alert.condition === "above" || alert.condition === "below")).map((alert) => alert.price),
  ].filter((price): price is number => typeof price === "number" && price > 0));
  const [targets, alerts, notes, history, read, quoted, watched, full, exchanges] = await Promise.all([
    deps.targets.get(environment),
    alertsRead,
    // All of the account's notes: one on a listed fill may name another instrument. A store that cannot be
    // read leaves the page without notes rather than without everything else.
    deps.journal.list(environment).catch(() => []),
    historyRead,
    deps.priceHistory?.({ instrument: subject, from: window.from, ...(position?.currentPrice ? { last: position.currentPrice } : { quote: quoteRead.then((read) => read?.price) }), levels, fills })
      .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message })),
    quoteRead,
    deps.watchlist?.get(environment, ticker).catch(() => undefined),
    subjectRead,
    // One read of the exchanges (Trading 212 allows one in 30 seconds) for the market session and the trading day.
    deps.insights.schedules(environment).catch(() => undefined),
  ]);
  const market = exchanges ? marketStatusOf(full, exchanges, now) : undefined;
  // A Trading 212 position names its instrument by ticker, name, ISIN and currency only: the type and short name
  // come from the instrument list, read above.
  const instrument = {
    ticker,
    ...(full.name ? { name: full.name } : {}),
    ...(full.shortName ? { shortName: full.shortName } : {}),
    ...(full.currencyCode ? { currencyCode: full.currencyCode } : {}),
    ...(full.type ? { type: full.type } : {}),
    ...(full.isin ? { isin: full.isin } : {}),
  };
  // The quote comes from the closes' mapping: in another unit when they are, and checked the same way when they did not come.
  const unitProblem = quoted ? quoteUnitProblem(quoted, ticker, unitReference(undefined, await levels, await fills)) : undefined;
  const quote = quoted && !unitProblem && !(read && "missing" in read && read.missing === "unit") ? quoted : undefined;
  const prices: PriceHistoryResult | undefined = unitProblem && !(read && "prices" in read) && !(read && read.missing === "unit") ? { missing: "unit", problem: unitProblem } : read;
  const target = targets?.targets.find((item) => item.ticker === ticker)?.weight;
  const listedFills = Array.isArray(history) ? history[0].fills.slice(0, MAX_FILLS) : [];
  // The splits among the fills, from the shares held now: the year's fills do not reach the first buy, but every fill
  // after a split read was read too, as the history is read newest first.
  const splitRead = Array.isArray(history)
    ? readSplits(history[0].fills, (fill) => {
      const quantity = Math.abs(fill.quantity ?? 0);
      return { key: ticker, time: Date.parse(fill.filledAt ?? ""), quantity: String(fill.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0 ? -quantity : quantity, split: isSplitType(fill.fillType) };
    }, () => position?.quantity ?? 0)
    : undefined;
  const splits = splitRead?.events.get(ticker);
  /** A fill of a split read: its shares are the split's, not a trade's. */
  const splitFills: ReadonlySet<unknown> = splitRead?.used ?? new Set();
  const splitFill = (fill: unknown) => splitFills.has(fill);
  const filled = new Set(listedFills.flatMap((fill) => (fill.orderId ? [fill.orderId] : [])));
  const onFill = (note: JournalEntry) => note.orderId !== undefined && filled.has(note.orderId);
  const relevant = notes.filter((note) => note.ticker === ticker || onFill(note));
  const journal = relevant.filter((note, index) => index < MAX_NOTES || onFill(note));
  // The day's move from the closes just read (or the day's kept close), with the day's fills from the history. A
  // quoted price does not move before the open, so the day of one not held is the last session until it opens.
  const session = sessionFinder(exchanges ?? [], now)(position ? full : { ...full, extendedHours: false });
  const accountCurrency = dashboard.account?.currency;
  const rates = accountCurrency ? knownFxRates(dashboard.positions, accountCurrency) : {};
  const accountRate = full.currencyCode ? rates[full.currencyCode.toUpperCase()] : undefined;
  // A holding's next year of dividends from its spacing (the newest MAX_DIVIDENDS payments: a monthly payer's year),
  // from the start of this month so one due and not paid yet still shows.
  const schedule = position && position.quantity > 0 && Array.isArray(history)
    ? dividendSchedule(history[1].items.flatMap((item) => (item.quantity && item.quantity > 0 && item.amount
      ? [{ at: Date.parse(item.date), perShare: item.amount / item.quantity, amount: item.amount, quantity: item.quantity }]
      : [])))
    : undefined;
  const nextDividends = schedule && position ? expectedPayments(schedule, position.quantity, monthStart(now.getTime()), addMonths(now.getTime(), 12) + DAY_MS) : [];
  const moved = prices && "prices" in prices
    ? await dayMove({ priceHistory: async () => prices, ...(deps.closes ? { closes: deps.closes } : {}) }, {
        environment, now, from: window.from, ...(accountCurrency ? { accountCurrency } : {}), rates,
      }, {
        ticker,
        instrument: full,
        ...(position ? { position } : {}),
        ...(quote ? { price: quote.price } : {}),
        session,
        fills: Array.isArray(history) ? fillsOfDay(history[0].fills, ticker, session) : [],
      })
    : undefined;
  // Nothing to say without a price now and nothing owned on the day.
  const shown = moved && (moved.change !== undefined || moved.profitLoss !== undefined || moved.missing) ? moved : undefined;
  const day = shown && shown.profitLoss !== undefined && !Array.isArray(history)
    ? { ...shown, problem: [shown.problem, "The order history could not be read, so shares traded on the day count from the previous close."].filter(Boolean).join(" ") }
    : shown;
  return {
    kind: "holding",
    environment,
    credentials: dashboard.credentials,
    ticker,
    instrument,
    ...(dashboard.account?.currency ? { accountCurrency: dashboard.account.currency } : {}),
    ...(accountRate ? { accountRate } : {}),
    ...(position ? { position } : {}),
    ...(quote ? { quote: { price: quote.price, asOf: quote.asOf, source: quote.source, symbol: quote.symbol } } : {}),
    ...(watched ? { watching: { addedAt: watched.addedAt, ...(watched.note ? { note: watched.note } : {}) } } : {}),
    ...(typeof value === "number" && typeof total === "number" && total > 0 ? { weight: value / total } : {}),
    ...(target === undefined ? {} : { targetWeight: target }),
    orders: dashboard.orders.filter((order) => order.ticker === ticker),
    alerts: alerts.filter((alert) => alert.ticker === ticker),
    journal,
    ...(relevant.length > journal.length ? { journalTotal: relevant.length } : {}),
    ...(market ? { market } : {}),
    ...(Array.isArray(history)
      ? {
          history: {
            from: window.from.toISOString(),
            dividendsFrom: dividendWindow.from.toISOString(),
            fills: listedFills.map((fill) => ({
              ...(fill.orderId ? { orderId: fill.orderId } : {}),
              ...(fill.filledAt ? { filledAt: fill.filledAt } : {}),
              ...(fill.side ? { side: fill.side } : {}),
              ...(fill.type ? { type: fill.type } : {}),
              ...(fill.quantity === undefined ? {} : { quantity: fill.quantity }),
              ...(fill.price === undefined ? {} : { price: fill.price }),
              ...(fill.priceCurrency ? { priceCurrency: fill.priceCurrency } : {}),
              ...(fill.netValue === undefined ? {} : { netValue: fill.netValue }),
              ...(fill.accountCurrency ? { accountCurrency: fill.accountCurrency } : {}),
              ...(fill.realisedProfitLoss === undefined ? {} : { realisedProfitLoss: fill.realisedProfitLoss }),
              ...(fill.fillType && fill.fillType.toUpperCase() !== "TRADE" ? { fillType: fill.fillType } : {}),
            })),
            ...(history[0].fills.length > MAX_FILLS ? {
              olderFills: history[0].fills.slice(MAX_FILLS).flatMap((fill) => (fill.filledAt && fill.price && !splitFill(fill)
                ? [{ filledAt: fill.filledAt, side: String(fill.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0 ? "SELL" : "BUY", quantity: Math.abs(fill.quantity ?? 0), price: fill.price }]
                : [])),
            } : {}),
            dividends: history[1].items.map((item) => ({
              date: item.date,
              amount: item.amount,
              currency: item.currency,
              ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
              ...(item.grossPerShare === undefined ? {} : { grossPerShare: item.grossPerShare, perShareCurrency: item.perShareCurrency ?? "" }),
            })),
            dividendTotal: history[1].totals.DIVIDEND ?? 0,
            dividendCount: history[1].count,
            fillsTruncated: history[0].truncated,
            ...(history[0].fills.some((fill) => fill.quantity && (!fill.filledAt || !fill.price) && !splitFill(fill)) ? { fillsUnpriced: true as const } : {}),
            ...(history[0].fills.some((fill) => fill.fillType && fill.fillType.toUpperCase() !== "TRADE" && !splitFill(fill)) ? { fillsNotTrades: true as const } : {}),
            ...(splits ? { splits } : {}),
            dividendsTruncated: history[1].truncated,
            ...(nextDividends.length ? { nextDividends: nextDividends.map((payment) => ({ on: new Date(payment.at).toISOString().slice(0, 10), amount: payment.amount })) } : {}),
            ...(nextDividends.length && schedule?.frequency ? { dividendFrequency: schedule.frequency } : {}),
          },
        }
      : { historyProblem: history.message }),
    ...(prices && "prices" in prices ? { prices: prices.prices } : prices ? { pricesMissing: prices.missing, pricesProblem: prices.problem } : {}),
    ...(day ? { day } : {}),
    timestamp: new Date().toISOString(),
  };
}
