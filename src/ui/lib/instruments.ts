import type { Instrument, PendingOrder, Position } from "../../shared/contracts";

/** What the widget has learned about an instrument from any payload it has seen. */
export interface KnownInstrument {
  name?: string;
  shortName?: string;
  currency?: string;
  type?: string;
}

/** Ticker → instrument facts, so views without names (income, pies, automation) can still show them. */
export type InstrumentBook = Record<string, KnownInstrument>;

const BOOK_STORAGE_KEY = "tradepilot212.instruments";
const BOOK_LIMIT = 400;

/** Trading 212 tickers end in a venue suffix: AAPL_US_EQ, VUSAl_EQ (London), SAPd_EQ (Xetra). */
export function symbolFromTicker(ticker: string): string {
  return ticker.replace(/_US_EQ$/, "").replace(/[a-z]?_EQ$/, "") || ticker;
}

export interface InstrumentLabel {
  /** The instrument's name, or its symbol when no name is known. */
  name: string;
  /** The symbol under the name; empty when it would only repeat the name. */
  detail: string;
  /** The exact Trading 212 ticker, for tooltips. */
  ticker: string;
}

/** One way to name an instrument everywhere: name first, symbol second, the raw ticker only on hover. */
export function instrumentLabel(ticker: string, book?: InstrumentBook, instrument?: Partial<Pick<Instrument, "name" | "shortName">>): InstrumentLabel {
  const known = book?.[ticker];
  const symbol = instrument?.shortName || known?.shortName || symbolFromTicker(ticker);
  const name = instrument?.name || known?.name || symbol;
  return { name, detail: name === symbol ? "" : symbol, ticker };
}

/** The label as running text: "Apple (AAPL)". */
export function instrumentText(ticker: string, book?: InstrumentBook, instrument?: Partial<Pick<Instrument, "name" | "shortName">>): string {
  const label = instrumentLabel(ticker, book, instrument);
  return label.detail ? `${label.name} (${label.detail})` : label.name;
}

/** The quote currency of an instrument: known facts first, then the US-ticker convention. */
export function instrumentCurrency(ticker: string, book?: InstrumentBook, instrument?: Partial<Pick<Instrument, "currencyCode">>): string | undefined {
  return instrument?.currencyCode || book?.[ticker]?.currency || (/_US_EQ$/.test(ticker) ? "USD" : undefined);
}

/** The currency of a pending order's prices, from the holding, the order itself or the ticker. */
export function orderCurrency(order: PendingOrder, positions: Position[] = [], book?: InstrumentBook): string | undefined {
  const ticker = typeof order.ticker === "string" ? order.ticker : "";
  const held = positions.find((position) => position.instrument.ticker === ticker)?.instrument;
  const embedded = order.instrument as { currencyCode?: unknown; currency?: unknown } | undefined;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return held?.currencyCode
    || text(embedded?.currencyCode)
    || text(embedded?.currency)
    || text(order.currency)
    || instrumentCurrency(ticker, book);
}

function add(book: InstrumentBook, ticker: unknown, facts: KnownInstrument): void {
  if (typeof ticker !== "string" || !ticker) return;
  const clean = Object.fromEntries(Object.entries(facts).filter(([, value]) => typeof value === "string" && value)) as KnownInstrument;
  if (Object.keys(clean).length) book[ticker] = { ...book[ticker], ...clean };
}

const fromInstrument = (instrument: Partial<Instrument> | undefined): KnownInstrument => ({
  ...(instrument?.name ? { name: instrument.name } : {}),
  ...(instrument?.shortName ? { shortName: instrument.shortName } : {}),
  ...(instrument?.currencyCode ? { currency: instrument.currencyCode } : {}),
  ...(instrument?.type ? { type: instrument.type } : {}),
});

/** Every instrument a tool payload names, whatever its kind. */
export function bookFromPayload(payload: unknown): InstrumentBook {
  const book: InstrumentBook = {};
  if (!payload || typeof payload !== "object") return book;
  const value = payload as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(value[key]) ? (value[key] as Array<Record<string, unknown>>) : []);
  for (const position of list("positions")) {
    const instrument = position.instrument as Partial<Instrument> | undefined;
    add(book, instrument?.ticker, fromInstrument(instrument));
  }
  for (const holding of list("holdings")) add(book, holding.ticker, { name: holding.name as string, currency: holding.currency as string, type: holding.type as string });
  for (const candidate of list("candidates")) {
    const instrument = candidate.resolvedInstrument as Partial<Instrument> | undefined;
    add(book, instrument?.ticker, fromInstrument(instrument));
  }
  for (const leg of list("legs")) {
    const instrument = leg.instrument as Partial<Instrument> | undefined;
    add(book, instrument?.ticker, fromInstrument(instrument));
  }
  for (const order of list("orders")) {
    const embedded = order.instrument as { name?: string; currencyCode?: string; currency?: string } | undefined;
    add(book, order.ticker, { name: embedded?.name ?? "", currency: embedded?.currencyCode ?? embedded?.currency ?? "" });
  }
  // Pages that list only tickers (automation) send the instruments they name alongside.
  for (const instrument of list("instruments")) add(book, instrument.ticker, fromInstrument(instrument as Partial<Instrument>));
  const resolved = value.resolvedInstrument as Partial<Instrument> | undefined;
  add(book, resolved?.ticker, fromInstrument(resolved));
  return book;
}

export function mergeBooks(base: InstrumentBook, extra: InstrumentBook): InstrumentBook {
  const keys = Object.keys(extra);
  if (!keys.length) return base;
  const next = { ...base };
  for (const key of keys) next[key] = { ...next[key], ...extra[key] };
  return next;
}

/** Names learned in earlier widgets, when the host allows local storage. */
export function readSavedBook(): InstrumentBook {
  try {
    const raw = localStorage.getItem(BOOK_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as InstrumentBook) : {};
  } catch {
    return {};
  }
}

export function saveBook(book: InstrumentBook): void {
  try {
    const entries = Object.entries(book).slice(-BOOK_LIMIT);
    localStorage.setItem(BOOK_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage may be unavailable in sandboxed hosts; names then come from the current payload only.
  }
}
