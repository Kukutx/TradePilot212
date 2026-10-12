// Looking back over the trade journal: each note on a filled order next to how the trade has gone since,
// and per tag how often the reasons given turned out right. The edge is worked out here, not by the model.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { HistoryOrderItem } from "../shared/history.js";
import { EDGE_FLAT, journalTagFilter, MAX_REVIEW_QUOTES, REVIEW_AFTER_DAYS, type JournalEntry, type JournalReview, type JournalTagStats, type JournalTrade } from "../shared/journal.js";
import type { HistoryWindow } from "./analytics.js";
import { DEFAULT_HISTORY_PAGES, type InsightsService } from "./insights-service.js";
import type { TradeJournal } from "./journal.js";
import type { TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Trades listed, newest first; the counts and tags cover them all. */
export const MAX_REVIEW_TRADES = 50;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function orderSide(item: HistoryOrderItem): "buy" | "sell" {
  const side = (item.order?.side ?? "").toUpperCase();
  return side === "SELL" || (item.fill?.quantity ?? 0) < 0 ? "sell" : "buy";
}

function stats(trades: JournalTrade[], tag?: string): JournalTagStats {
  const priced = trades.filter((trade) => trade.edge !== undefined);
  const edges = priced.map((trade) => trade.edge!);
  return {
    ...(tag === undefined ? {} : { tag }),
    trades: trades.length,
    priced: priced.length,
    inFavour: edges.filter((edge) => edge > EDGE_FLAT).length,
    ...(edges.length ? { averageEdge: round(edges.reduce((sum, edge) => sum + edge, 0) / edges.length, 6) } : {}),
    realisedProfitLoss: round(trades.reduce((sum, trade) => sum + (trade.realisedProfitLoss ?? 0), 0), 2),
  };
}

export interface JournalReviewInput {
  environment: TradingEnvironment;
  notes: JournalEntry[];
  /** Order history for the window, newest first. */
  orders: HistoryOrderItem[];
  window: HistoryWindow;
  /** The price now per ticker, in the instrument's currency. */
  prices: Map<string, number>;
  /**
   * Tickers priced by the quote provider. Its symbol map can name a price in another unit (pounds for a fund in
   * pence), so a quote ten times from the fill price either way counts as no price.
   */
  quoted?: Set<string>;
  /** Tickers left unpriced because of the quote limit. */
  notQuoted?: string[];
  names?: Map<string, string>;
  truncated: boolean;
  /** Only notes with this tag (any case). */
  tag?: string;
  now?: Date;
}

const tagKey = (tag: string | undefined) => journalTagFilter(tag)?.toLowerCase();
const tickerOf = (item: HistoryOrderItem, entry: JournalEntry) => item.order?.ticker ?? item.order?.instrument?.ticker ?? entry.ticker;

/** The notes on orders filled in the window, each with its fill, newest fill first; and what did not match. */
function matchNotes(input: Pick<JournalReviewInput, "notes" | "orders" | "window" | "tag">) {
  const wanted = tagKey(input.tag);
  const notes = wanted ? input.notes.filter((note) => note.tags?.some((tag) => tag.toLowerCase() === wanted)) : input.notes;
  const from = input.window.from?.getTime() ?? -Infinity;
  const to = input.window.to.getTime();
  const fills = new Map<string, HistoryOrderItem>();
  let fillCount = 0;
  for (const item of input.orders) {
    const at = Date.parse(item.fill?.filledAt ?? "");
    if (!item.fill || !Number.isFinite(at) || at < from || at > to) continue;
    fillCount++;
    if (item.order?.id !== undefined && item.order.id !== null && item.order.id !== "") fills.set(String(item.order.id), item);
  }
  const matched: Array<{ entry: JournalEntry; item: HistoryOrderItem }> = [];
  let unmatched = 0, withoutOrder = 0;
  for (const entry of notes) {
    if (!entry.orderId) { withoutOrder++; continue; }
    const item = fills.get(entry.orderId);
    if (!item?.fill?.filledAt || !item.fill.price || item.fill.price <= 0) { unmatched++; continue; }
    matched.push({ entry, item });
  }
  matched.sort((a, b) => Date.parse(b.item.fill!.filledAt!) - Date.parse(a.item.fill!.filledAt!));
  return { matched, fillCount, unmatched, withoutOrder, wanted };
}

/**
 * Match each note on an order to that order's fill in the window, and set the fill price against the price now.
 * The edge is the move in the trade's favour: the change for a buy, its opposite for a sell; FX and costs are
 * left out, and each trade counts once whatever its size.
 */
export function summarizeJournalReview(input: JournalReviewInput): JournalReview {
  const now = input.now ?? new Date();
  const { matched, fillCount, unmatched, withoutOrder, wanted } = matchNotes(input);
  const trades: JournalTrade[] = [];
  for (const { entry, item } of matched) {
    const fill = item.fill!;
    const price = fill.price!;
    const side = orderSide(item);
    const ticker = tickerOf(item, entry);
    const quotedPrice = input.prices.get(ticker);
    const ratio = quotedPrice !== undefined && quotedPrice > 0 ? quotedPrice / price : undefined;
    const priceNow = ratio !== undefined && !(input.quoted?.has(ticker) && (ratio >= 10 || ratio <= 0.1)) ? quotedPrice : undefined;
    const move = priceNow !== undefined ? priceNow / price - 1 : undefined;
    const days = Math.max(0, Math.floor((now.getTime() - Date.parse(fill.filledAt!)) / DAY_MS));
    const name = input.names?.get(ticker) ?? item.order?.instrument?.name;
    const realised = side === "sell" ? fill.walletImpact?.realisedProfitLoss : undefined;
    const currency = item.order?.currency ?? item.order?.instrument?.currency;
    trades.push({
      entry,
      ticker,
      ...(name ? { name } : {}),
      side,
      quantity: Math.abs(fill.quantity ?? item.order?.filledQuantity ?? 0),
      price,
      ...(currency ? { priceCurrency: currency } : {}),
      filledAt: fill.filledAt!,
      days,
      ...(move === undefined ? {} : { priceNow: priceNow!, move: round(move, 6), edge: round(side === "buy" ? move : -move, 6) }),
      ...(realised === undefined ? {} : { realisedProfitLoss: realised }),
      ...(entry.thesis && !entry.review && days >= REVIEW_AFTER_DAYS ? { due: true as const } : {}),
    });
  }

  const byTag = new Map<string, { tag: string; trades: JournalTrade[] }>();
  const untagged: JournalTrade[] = [];
  for (const trade of trades) {
    if (!trade.entry.tags?.length) { untagged.push(trade); continue; }
    for (const tag of trade.entry.tags) {
      const key = tag.toLowerCase();
      const group = byTag.get(key) ?? { tag, trades: [] };
      group.trades.push(trade);
      byTag.set(key, group);
    }
  }
  const tags = [...byTag.values()].map((group) => stats(group.trades, group.tag))
    .sort((a, b) => b.trades - a.trades || (a.tag ?? "").localeCompare(b.tag ?? ""));
  if (untagged.length && byTag.size) tags.push(stats(untagged));
  const accountCurrency = input.orders.find((item) => item.fill?.walletImpact?.currency)?.fill?.walletImpact?.currency;
  const unpriced = [...new Set(trades.filter((trade) => trade.move === undefined).map((trade) => trade.ticker))];

  return {
    kind: "journal_review",
    environment: input.environment,
    period: { ...(input.window.from ? { from: input.window.from.toISOString() } : {}), to: input.window.to.toISOString() },
    ...(accountCurrency ? { accountCurrency } : {}),
    ...(wanted ? { tag: journalTagFilter(input.tag)! } : {}),
    fills: fillCount,
    withNote: trades.length,
    overall: stats(trades),
    tags,
    reviewed: trades.filter((trade) => trade.entry.review).length,
    due: trades.filter((trade) => trade.due).length,
    trades: trades.slice(0, MAX_REVIEW_TRADES),
    tradesTotal: trades.length,
    unmatched,
    withoutOrder,
    unpriced: unpriced.filter((ticker) => !input.notQuoted?.includes(ticker)),
    notQuoted: (input.notQuoted ?? []).filter((ticker) => unpriced.includes(ticker)),
    truncated: input.truncated,
    timestamp: now.toISOString(),
  };
}

export interface JournalReviewDeps {
  journal: TradeJournal;
  insights: InsightsService;
  trading: TradingService;
}

/**
 * Read the notes, the window's order history (shared with the performance view's cache) and the prices now:
 * the broker's for held instruments, the quote provider's for up to MAX_REVIEW_QUOTES others, asked one at a
 * time, since free plans allow only a few requests a minute and price alerts share them.
 */
export async function journalReview(deps: JournalReviewDeps, environment: TradingEnvironment, window: HistoryWindow, options: { tag?: string; maxPages?: number } = {}, now = new Date()): Promise<JournalReview> {
  const [notes, history, positions, instruments] = await Promise.all([
    deps.journal.list(environment),
    deps.insights.collect(environment, "orders", window, options.maxPages ?? DEFAULT_HISTORY_PAGES),
    deps.trading.positions(environment),
    deps.trading.instruments(environment).catch(() => []),
  ]);
  const prices = new Map<string, number>();
  for (const position of positions) {
    if (position.instrument?.ticker && position.currentPrice && position.currentPrice > 0) prices.set(position.instrument.ticker, position.currentPrice);
  }
  const names = new Map(instruments.map((instrument) => [instrument.ticker, instrument.name ?? instrument.shortName ?? instrument.ticker] as const));
  // Price only what a note is on, newest trades first, so the quote provider is asked about a few instruments.
  const { matched } = matchNotes({ notes, orders: history.items, window, ...(options.tag ? { tag: options.tag } : {}) });
  const wanted = [...new Set(matched.map(({ entry, item }) => tickerOf(item, entry)))].filter((ticker) => !prices.has(ticker));
  const quoted = new Set<string>();
  for (const ticker of wanted.slice(0, MAX_REVIEW_QUOTES)) {
    const instrument = instruments.find((item) => item.ticker === ticker);
    const quote = instrument ? await deps.trading.externalQuote(instrument).catch(() => undefined) : undefined;
    if (quote?.price && quote.price > 0) { prices.set(ticker, quote.price); quoted.add(ticker); }
  }
  return summarizeJournalReview({
    environment, notes, orders: history.items, window, prices, quoted, notQuoted: wanted.slice(MAX_REVIEW_QUOTES), names,
    truncated: history.truncated, ...(options.tag ? { tag: options.tag } : {}), now,
  });
}
