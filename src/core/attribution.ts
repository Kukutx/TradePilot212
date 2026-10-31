// Where a period's gain came from: each instrument's value now against its value at the start, less what was put in
// and plus what was taken out and paid as dividends. Trading 212 reports only today's values, so the start is the
// shares held then (today's, less the buys since, plus the sells since) at the quote provider's close before it.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { GainAttribution, HistoryDividendItem, HistoryOrderItem, HoldingGain, PerformanceSummary } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import { isTradeFill } from "../shared/splits.js";
import type { HistoryWindow } from "./analytics.js";
import { asStructuredError } from "./errors.js";
import { knownFxRates, type FxRates } from "./fx.js";
import type { InsightsService } from "./insights-service.js";
import { eachLimited, settleWithin, type PriceAnchor, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Instruments whose closes are read at once; each read is cached by the price history. */
const CONCURRENCY = 4;
/** No new read of closes starts after this long; the instruments left wait for the next read, when the rest are cached. */
const READ_BUDGET_MS = 5000;
/** The instrument list is optional here: at most this long. */
const LIST_WAIT_MS = 3000;
/** A close further back than this before the start is too old to value it at. */
const STALE_CLOSE_DAYS = 10;
/** Fewer shares than this are none (fractional shares are rounded by the broker). */
const NO_SHARES = 1e-6;

const round = (value: number) => Math.round(value * 100) / 100;
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

/** One instrument's trading and dividends in the period. */
export interface HoldingFlows {
  boughtQuantity: number;
  soldQuantity: number;
  /** In the account currency: what the buys took and the sells paid (`walletImpact.netValue`). */
  bought: number;
  sold: number;
  dividends: number;
  /** Fills without an account amount, in the instrument's currency: converted at today's rate. */
  boughtLocal: number;
  soldLocal: number;
  /** The fills with both amounts, for a rate when the instrument's currency is no longer held. */
  rated: { local: number; account: number };
  /** The fills, as the closes' unit check. */
  anchors: PriceAnchor[];
  /** Trading 212's realised P/L on the sells. */
  realized: number;
  /** Fills of a split or another corporate action: shares that changed without a trade, left out of the rest. */
  notTrades: number;
}

const emptyFlows = (): HoldingFlows => ({ boughtQuantity: 0, soldQuantity: 0, bought: 0, sold: 0, dividends: 0, boughtLocal: 0, soldLocal: 0, rated: { local: 0, account: 0 }, anchors: [], realized: 0, notTrades: 0 });

/** Each instrument's fills and dividends from `from` (all history without it) to `to`. */
export function holdingFlows(orders: HistoryOrderItem[], dividends: HistoryDividendItem[], from: number | undefined, to: number): Map<string, HoldingFlows> {
  const flows = new Map<string, HoldingFlows>();
  const of = (ticker: string) => {
    let entry = flows.get(ticker);
    if (!entry) flows.set(ticker, (entry = emptyFlows()));
    return entry;
  };
  const within = (value: string | undefined) => {
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) && (from === undefined || at >= from) && at <= to;
  };
  for (const item of orders) {
    const fill = item.fill;
    const ticker = item.order?.ticker ?? item.order?.instrument?.ticker;
    if (!fill || !ticker || !within(fill.filledAt ?? item.order?.createdAt)) continue;
    const quantity = Math.abs(fill.quantity ?? item.order?.filledQuantity ?? 0);
    if (!(quantity > 0)) continue;
    const sell = (item.order?.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0;
    const entry = of(ticker);
    if (!isTradeFill(item)) { entry.notTrades += 1; continue; }
    const net = fill.walletImpact?.netValue;
    const local = fill.price && fill.price > 0 ? quantity * fill.price : undefined;
    if (sell) entry.soldQuantity += quantity; else entry.boughtQuantity += quantity;
    if (typeof net === "number" && Number.isFinite(net)) {
      if (sell) entry.sold += Math.abs(net); else entry.bought += Math.abs(net);
      if (local) { entry.rated.local += local; entry.rated.account += Math.abs(net); }
    } else if (local) {
      if (sell) entry.soldLocal += local; else entry.boughtLocal += local;
    }
    if (fill.price && fill.price > 0 && fill.filledAt) entry.anchors.push({ at: fill.filledAt, price: fill.price });
    entry.realized += fill.walletImpact?.realisedProfitLoss ?? 0;
  }
  for (const item of dividends) {
    const ticker = item.ticker ?? item.instrument?.ticker;
    if (!ticker || !item.amount || !within(item.paidOn)) continue;
    of(ticker).dividends += item.amount;
  }
  return flows;
}

/** The close an instrument's start is valued at: the last before `day`, if it is recent enough. */
export function closeBefore(points: PricePoint[], day: string): PricePoint | undefined {
  let found: PricePoint | undefined;
  for (const point of points) if (point.date < day && point.close > 0) found = point;
  if (!found) return undefined;
  return Date.parse(`${day}T00:00:00Z`) - Date.parse(`${found.date}T00:00:00Z`) <= STALE_CLOSE_DAYS * DAY_MS ? found : undefined;
}

export type StartClose = PricePoint | { missing: GainAttribution["missing"][number]["reason"]; problem: string };

/**
 * Over all history there is no start to value: each instrument's gain is Trading 212's own accounting, its realised
 * P/L on the sells, its unrealised P/L on what is held now and its dividends, so shares bought before the history
 * read count from what they cost.
 */
export function allTimeGains(input: { to: number; positions: Position[]; flows: Map<string, HoldingFlows> }): GainAttribution {
  const held = new Map(input.positions.filter((position) => position.instrument?.ticker && position.quantity > 0).map((position) => [position.instrument.ticker, position]));
  const holdings: HoldingGain[] = [];
  const missing: GainAttribution["missing"] = [];
  for (const ticker of new Set([...held.keys(), ...input.flows.keys()])) {
    const position = held.get(ticker);
    const flows = input.flows.get(ticker) ?? emptyFlows();
    const wallet = position?.walletImpact as { currentValue?: unknown; unrealizedProfitLoss?: unknown } | undefined;
    if (position && (typeof wallet?.unrealizedProfitLoss !== "number" || typeof wallet.currentValue !== "number")) {
      missing.push({ ticker, reason: "data", problem: `Trading 212 gave no value or unrealised P/L for ${ticker}.` });
      continue;
    }
    const unrealized = position ? (wallet!.unrealizedProfitLoss as number) : 0;
    const gain = flows.realized + unrealized + flows.dividends;
    holdings.push({
      ticker,
      startQuantity: 0,
      quantity: position?.quantity ?? 0,
      startValue: 0,
      value: round(position ? (wallet!.currentValue as number) : 0),
      bought: round(flows.bought),
      sold: round(flows.sold),
      dividends: round(flows.dividends),
      gain: round(gain),
    });
  }
  holdings.sort((a, b) => b.gain - a.gain);
  return { basis: "cost", to: new Date(input.to).toISOString(), holdings, total: round(holdings.reduce((sum, holding) => sum + holding.gain, 0)), missing };
}

/**
 * The attribution from what was read: the holdings now, each instrument's flows over the period, the close before the
 * start of each that was held then (`closes`, by ticker), and exchange rates (instrument-currency units per account
 * unit).
 */
export function attributeGains(input: {
  from: number;
  to: number;
  positions: Position[];
  flows: Map<string, HoldingFlows>;
  closes: Map<string, StartClose>;
  currencies: Map<string, string>;
  rates: FxRates;
}): GainAttribution {
  const held = new Map(input.positions.filter((position) => position.instrument?.ticker && position.quantity > 0).map((position) => [position.instrument.ticker, position]));
  const tickers = [...new Set([...held.keys(), ...input.flows.keys()])];
  const holdings: HoldingGain[] = [];
  const missing: GainAttribution["missing"] = [];
  for (const ticker of tickers) {
    const position = held.get(ticker);
    const flows = input.flows.get(ticker) ?? emptyFlows();
    const quantity = position?.quantity ?? 0;
    let startQuantity = quantity - flows.boughtQuantity + flows.soldQuantity;
    if (Math.abs(startQuantity) < NO_SHARES) startQuantity = 0;
    // Across a split the shares at the start are in other units than today's, and its close may be either.
    if (flows.notTrades) {
      missing.push({ ticker, reason: "quantity", problem: `${ticker} had a split or another corporate action since the start (${flows.notTrades} fill(s) that were not trades), so its shares then and now are not in the same units.` });
      continue;
    }
    if (startQuantity < 0) {
      missing.push({ ticker, reason: "quantity", problem: `${ticker}'s shares do not add up: ${quantity} now, ${flows.boughtQuantity} bought and ${flows.soldQuantity} sold since the start. A split, or shares moved in or out, changes the count without a fill.` });
      continue;
    }
    const currency = input.currencies.get(ticker) ?? (position?.instrument?.currencyCode ?? "");
    // Instrument-currency units per account unit: today's, or the instrument's own fills' when its currency is not held now.
    const rate = input.rates[currency.toUpperCase()] ?? (flows.rated.account > 0 ? flows.rated.local / flows.rated.account : undefined);
    const needsRate = startQuantity > 0 || flows.boughtLocal > 0 || flows.soldLocal > 0 || (position && typeof (position.walletImpact as { currentValue?: unknown } | undefined)?.currentValue !== "number");
    if (needsRate && !(rate && rate > 0)) {
      missing.push({ ticker, reason: "rate", problem: `No exchange rate from ${currency || "its currency"} to the account currency is known for ${ticker}.` });
      continue;
    }
    let startValue = 0;
    let startClose: PricePoint | undefined;
    if (startQuantity > 0) {
      const close = input.closes.get(ticker);
      if (!close || "missing" in close) {
        missing.push({ ticker, reason: close?.missing ?? "data", problem: close?.problem ?? `No close for ${ticker} before the start.` });
        continue;
      }
      startClose = close;
      startValue = (startQuantity * close.close) / rate!;
    }
    const wallet = position?.walletImpact as { currentValue?: unknown } | undefined;
    const value = !position ? 0 : typeof wallet?.currentValue === "number" ? wallet.currentValue : (position.quantity * position.currentPrice) / rate!;
    const bought = flows.bought + (flows.boughtLocal ? flows.boughtLocal / rate! : 0);
    const sold = flows.sold + (flows.soldLocal ? flows.soldLocal / rate! : 0);
    const gain = value - startValue - bought + sold + flows.dividends;
    const atWork = startValue + bought;
    holdings.push({
      ticker,
      startQuantity,
      quantity,
      ...(startClose ? { startClose: { date: startClose.date, price: startClose.close } } : {}),
      startValue: round(startValue),
      value: round(value),
      bought: round(bought),
      sold: round(sold),
      dividends: round(flows.dividends),
      gain: round(gain),
      ...(atWork > 0 ? { return: Math.round((gain / atWork) * 10_000) / 10_000 } : {}),
    });
  }
  holdings.sort((a, b) => b.gain - a.gain);
  return {
    from: dayOf(input.from),
    basis: "start",
    to: new Date(input.to).toISOString(),
    holdings,
    total: round(holdings.reduce((sum, holding) => sum + holding.gain, 0)),
    missing,
  };
}

export interface AttributionDeps {
  config: { sampleData: boolean };
  trading: Pick<TradingService, "getDashboard" | "instruments" | "externalQuote">;
  insights: Pick<InsightsService, "collect">;
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** The orders and dividends the performance summary has just read for the same window, so they are not read again. */
  history?: { orders: Collected<HistoryOrderItem>; dividends: Collected<HistoryDividendItem> };
  /** How long new reads of closes are started for; the default suits a tool call. */
  budgetMs?: number;
}

interface Collected<T> { items: T[]; truncated: boolean }

/**
 * The performance summary's attribution for `window`: the fills and dividends from the start of its first day (read as
 * the summary reads them, so from the same cache), today's holdings, and the close before that day of each instrument
 * held then. Instruments without one are listed as missing; a history cut short leaves the attribution out.
 */
export async function readAttribution(deps: AttributionDeps, environment: TradingEnvironment, window: HistoryWindow, maxPages?: number, now = new Date()):
  Promise<Pick<PerformanceSummary, "attribution" | "attributionProblem" | "attributionMissing">> {
  // Whole days: the start is valued at a close, so the fills counted begin with the day after it.
  const from = window.from ? Math.floor(window.from.getTime() / DAY_MS) * DAY_MS : undefined;
  const to = Math.min(window.to.getTime(), now.getTime());
  if (window.to.getTime() < now.getTime() - 5 * 60_000) {
    return { attributionMissing: "period", attributionProblem: "Only today's holdings are known, so gains by instrument need a period that ends now." };
  }
  const [dashboard, orders, dividends] = await Promise.all([
    deps.trading.getDashboard(environment, 15_000),
    deps.history?.orders ?? deps.insights.collect(environment, "orders", window, maxPages),
    deps.history?.dividends ?? deps.insights.collect(environment, "dividends", window, maxPages),
  ]);
  if (orders.truncated || dividends.truncated) {
    return {
      attributionMissing: "history",
      attributionProblem: `The ${orders.truncated ? "order" : "dividend"} history stops at the page limit before the start, so ${orders.truncated ? "the shares held then are not known" : "some dividends would be left out"}; raise maxPages.`,
    };
  }
  const accountCurrency = dashboard.account?.currency ?? "";
  if (!accountCurrency) return { attributionMissing: "data", attributionProblem: "Trading 212 did not give the account currency." };
  const positions = dashboard.positions;
  const flows = holdingFlows(orders.items, dividends.items, from, to);
  if (from === undefined) return { attribution: allTimeGains({ to, positions, flows }) };
  const held = new Map(positions.flatMap((position) => (position.instrument?.ticker && position.quantity > 0 ? [[position.instrument.ticker, position] as const] : [])));
  // What was held at the start needs a close; whatever was bought since does not.
  const starting = [...new Set([...held.keys(), ...flows.keys()])].filter((ticker) => {
    const entry = flows.get(ticker);
    return (held.get(ticker)?.quantity ?? 0) - (entry?.boughtQuantity ?? 0) + (entry?.soldQuantity ?? 0) > NO_SHARES;
  });
  const sold = [...flows.keys()].filter((ticker) => !held.has(ticker));
  const instruments = starting.some((ticker) => !held.has(ticker)) || sold.length
    ? await settleWithin(deps.trading.instruments(environment).catch((): Instrument[] => []), LIST_WAIT_MS) ?? []
    : [];
  const listed = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
  const currencies = new Map<string, string>();
  for (const ticker of [...held.keys(), ...flows.keys()]) {
    const instrument = held.get(ticker)?.instrument as { currencyCode?: string; currency?: string } | undefined;
    const order = orders.items.find((item) => (item.order?.ticker ?? item.order?.instrument?.ticker) === ticker)?.order;
    const currency = listed.get(ticker)?.currencyCode ?? instrument?.currencyCode ?? instrument?.currency ?? order?.instrument?.currency ?? order?.currency;
    if (currency) currencies.set(ticker, currency);
  }

  const closes = new Map<string, StartClose>();
  if (starting.length) {
    const day = dayOf(from);
    // A year back at least, from the start of today (UTC), as the holding page and the benchmark ask: one cached read.
    const readFrom = new Date(Math.min(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS, from - (STALE_CLOSE_DAYS + 1) * DAY_MS));
    const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
    const read = async (ticker: string): Promise<StartClose> => {
      const position = held.get(ticker);
      const instrument = listed.get(ticker) ?? position?.instrument;
      if (!instrument) return { missing: "data", problem: `Trading 212 does not list ${ticker} at the moment.` };
      if (!deps.priceHistory) return { missing: "provider", problem: "No quote provider is configured, so there are no closes to value the start at." };
      const anchors = flows.get(ticker)?.anchors ?? [];
      const result = await deps.priceHistory({
        instrument,
        from: readFrom,
        ...(position?.currentPrice ? { last: position.currentPrice } : {}),
        // The sample account draws an instrument it no longer holds through the provider's price, and each path through
        // its own fills, as the holding page draws it.
        ...(deps.config.sampleData
          ? (position ? {} : { quote: deps.trading.externalQuote(instrument).then((quote) => quote?.price).catch(() => undefined) })
          : { fills: Promise.resolve(anchors) }),
      }).catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
      if (!("prices" in result)) return result;
      const close = closeBefore(result.prices.points, day);
      return close ?? { missing: "data", problem: `${result.prices.source} has no close for ${result.prices.symbol ?? ticker} in the ${STALE_CLOSE_DAYS} days before ${day}.` };
    };
    const later = async (ticker: string): Promise<StartClose> => ({ missing: "later", problem: `${ticker}'s closes are asked for on the next read: this one ran out of time.` });
    const results = await eachLimited(starting, CONCURRENCY, deadline, read, later);
    starting.forEach((ticker, index) => closes.set(ticker, results[index]!));
  }
  return {
    attribution: attributeGains({ from, to, positions, flows, closes, currencies, rates: knownFxRates(positions, accountCurrency) }),
  };
}
