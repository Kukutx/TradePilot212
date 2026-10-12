// External quotes for instruments you do not hold. Trading 212's Public API has no quote endpoint,
// so without this the broker only reports prices for held positions.
//
// Providers are pluggable (QUOTE_PROVIDER). The default, Stooq, is free and needs no account but is
// unofficial and best effort. Finnhub, Twelve Data and Alpha Vantage need a free key (QUOTE_API_KEY).
// Only US-listed instruments are mapped automatically; others need an explicit QUOTE_SYMBOLS entry,
// because exchange suffixes and price units (for example GBX pence) differ between providers.

import type { Instrument } from "../shared/contracts.js";
import type { PriceHistory, PricePoint } from "../shared/prices.js";
import type { RuntimeConfig } from "./config.js";

export type QuoteProviderName = "stooq" | "finnhub" | "twelvedata" | "alphavantage" | "none";
export const QUOTE_PROVIDERS: QuoteProviderName[] = ["stooq", "finnhub", "twelvedata", "alphavantage", "none"];
/** Where a price came from: a configured provider, or the sample account's simulated prices. */
export type QuoteSource = QuoteProviderName | "sample";

export interface ExternalQuote {
  ticker: string;
  symbol: string;
  price: number;
  /** When the provider says the price is from; otherwise when it was fetched. */
  asOf: string;
  source: QuoteSource;
}

export interface ExternalFxRate {
  from: string;
  to: string;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  asOf: string;
  source: QuoteSource;
}

/** `fresh` asks the provider itself, past the cache: the check made just before an order is sent needs the price of that moment. */
export interface QuoteOptions {
  fresh?: boolean;
}

export interface QuoteProvider {
  name: QuoteSource;
  /** The provider symbol for an instrument, or undefined when it cannot be mapped safely. */
  symbolFor(instrument: Instrument): string | undefined;
  quote(instrument: Instrument, options?: QuoteOptions): Promise<ExternalQuote | undefined>;
  /** An exchange rate, for currencies none of your holdings price; undefined when the provider has none. */
  fxRate(from: string, to: string, options?: QuoteOptions): Promise<ExternalFxRate | undefined>;
  /** False when the provider never has exchange rates, so a missing one is not a failure of the moment. */
  hasFxRates?: boolean;
  /**
   * Daily closes from `from` to the latest, oldest first, in the instrument's unit; undefined when the provider has
   * none for it, and thrown with the provider's words when it refuses (a limit, a plan). Absent when the provider's
   * free plan has no daily history.
   */
  history?(instrument: Instrument, from: Date): Promise<PriceHistory | undefined>;
}

const CACHE_MS = 60_000;
/** Daily closes change once a day, so a chart opened again within half an hour asks nothing. */
const HISTORY_CACHE_MS = 30 * 60_000;

/** The plain US symbol of a Trading 212 US ticker, e.g. AAPL_US_EQ → AAPL, BRK.B_US_EQ → BRK.B. */
export function usSymbol(ticker: string): string | undefined {
  const match = /^([A-Z0-9.]+)_US_EQ$/.exec(ticker);
  return match?.[1];
}

/**
 * Parse QUOTE_SYMBOLS, e.g. "VUSAl_EQ=VUSA.UK, SAPd_EQ=SAP.DE". Keys are exact Trading 212 tickers.
 * A "*factor" suffix scales the provider's price into the instrument's unit, e.g. "VUSAl_EQ=VUSA.L*100"
 * when the provider quotes in pounds and Trading 212 in pence.
 */
export function parseSymbolMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const [ticker, symbol] = entry.split("=");
    if (!ticker || !symbol) throw new Error(`QUOTE_SYMBOLS entry "${entry}" must look like TICKER=SYMBOL`);
    if (symbol.includes("*") && !symbolScale(symbol.trim())) throw new Error(`QUOTE_SYMBOLS entry "${entry}": the factor after * must be a positive number`);
    map.set(ticker.trim().toUpperCase(), symbol.trim());
  }
  return map;
}

/** A mapped symbol and the factor its prices are multiplied by. */
function symbolScale(mapped: string): { symbol: string; factor: number } | undefined {
  const [symbol, factor] = mapped.split("*");
  if (factor === undefined) return symbol ? { symbol, factor: 1 } : undefined;
  const value = Number(factor);
  return symbol && Number.isFinite(value) && value > 0 ? { symbol, factor: value } : undefined;
}

const positive = (value: unknown): number | undefined => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
};

type Fetch = typeof fetch;
type Fetcher = (symbol: string) => Promise<{ price: number; asOf?: string } | undefined>;

async function getJson(fetcher: Fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Quote provider returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

function providerFetcher(name: Exclude<QuoteProviderName, "none">, key: string, fetcher: Fetch): Fetcher {
  switch (name) {
    case "stooq":
      return async (symbol) => {
        // CSV: Symbol,Date,Time,Close. "N/D" means no data for the symbol.
        const response = await fetcher(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}&f=sd2t2c&h&e=csv`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Stooq returned ${response.status}`);
        const [, row] = (await response.text()).trim().split(/\r?\n/);
        const [, date, time, close] = (row ?? "").split(",");
        const price = positive(close);
        if (!price) return undefined;
        const asOf = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T${time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : "00:00:00"}Z` : undefined;
        return { price, ...(asOf ? { asOf } : {}) };
      };
    case "finnhub":
      return async (symbol) => {
        const body = await getJson(fetcher, `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`) as { c?: number; t?: number };
        const price = positive(body.c);
        return price ? { price, ...(body.t ? { asOf: new Date(body.t * 1000).toISOString() } : {}) } : undefined;
      };
    case "twelvedata":
      return async (symbol) => {
        const body = await getJson(fetcher, `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`) as { price?: string };
        const price = positive(body.price);
        return price ? { price } : undefined;
      };
    case "alphavantage":
      return async (symbol) => {
        const body = await getJson(fetcher, `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`) as { "Global Quote"?: Record<string, string> };
        const quote = body["Global Quote"] ?? {};
        const price = positive(quote["05. price"]);
        const day = quote["07. latest trading day"];
        return price ? { price, ...(day ? { asOf: `${day}T00:00:00Z` } : {}) } : undefined;
      };
  }
}

type HistoryFetcher = (symbol: string, from: Date) => Promise<PricePoint[]>;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** The rows that are a trading day and a positive close. */
function closes(rows: Array<{ date?: unknown; close?: unknown }>): PricePoint[] {
  return rows.flatMap(({ date, close }) => {
    const price = positive(close);
    return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && price ? [{ date, close: price }] : [];
  });
}

/** A provider's own words on why it sent no prices (a limit, a plan, a symbol), with the key never repeated. */
function providerSays(provider: string, key: string, said: unknown): Error {
  const text = (typeof said === "string" ? said : JSON.stringify(said)).replace(/\s+/g, " ").trim();
  return new Error(`${provider}: ${(key ? text.replaceAll(key, "***") : text).slice(0, 200)}`);
}

/**
 * Daily history per provider, or undefined when its free plan has none (Finnhub's candles are paid). An unknown
 * symbol is no closes; a limit or an error the provider names is thrown with its words.
 */
function historyFetcher(name: Exclude<QuoteProviderName, "none">, key: string, fetcher: Fetch): HistoryFetcher | undefined {
  switch (name) {
    case "stooq":
      return async (symbol, from) => {
        // CSV: Date,Open,High,Low,Close,Volume. "No data" is an unknown symbol; other text (a daily limit) is said.
        const range = `d1=${isoDay(from).replaceAll("-", "")}&d2=${isoDay(new Date()).replaceAll("-", "")}`;
        const response = await fetcher(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&${range}&i=d`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Stooq returned ${response.status}`);
        const [header = "", ...rows] = (await response.text()).trim().split(/\r?\n/);
        const columns = header.split(",");
        const close = columns.indexOf("Close");
        if (/^no data/i.test(header)) return [];
        if (columns[0] !== "Date" || close < 0) throw providerSays("Stooq", key, /^\s*</.test(header) ? "answered with a web page instead of prices" : header);
        return closes(rows.map((row) => { const cells = row.split(","); return { date: cells[0], close: cells[close] }; }));
      };
    case "twelvedata":
      return async (symbol, from) => {
        const body = await getJson(fetcher, `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${isoDay(from)}&outputsize=5000&apikey=${encodeURIComponent(key)}`) as { status?: string; message?: string; values?: Array<{ datetime?: string; close?: string }> };
        if (body?.status === "error") throw providerSays("Twelve Data", key, body.message ?? "error");
        return closes((body.values ?? []).map((row) => ({ date: row.datetime?.slice(0, 10), close: row.close })));
      };
    case "alphavantage":
      return async (symbol) => {
        // The free plan gives the latest 100 trading days.
        const body = await getJson(fetcher, `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(key)}`) as Record<string, unknown> & { "Time Series (Daily)"?: Record<string, Record<string, string>> };
        const said = body?.Note ?? body?.Information ?? body?.["Error Message"];
        if (said !== undefined) throw providerSays("Alpha Vantage", key, said);
        return closes(Object.entries(body["Time Series (Daily)"] ?? {}).map(([date, row]) => ({ date, close: row["4. close"] })));
      };
    case "finnhub":
      return undefined;
  }
}

/** The provider's symbol for a currency pair, or undefined when it has no free exchange rates. */
function fxSymbol(name: Exclude<QuoteProviderName, "none">, from: string, to: string): string | undefined {
  switch (name) {
    case "stooq": return `${from}${to}`;
    case "twelvedata": return `${from}/${to}`;
    case "alphavantage": return `${from}:${to}`;
    case "finnhub": return undefined;
  }
}

function fxFetcher(name: Exclude<QuoteProviderName, "none">, key: string, fetcher: Fetch): Fetcher {
  if (name !== "alphavantage") return providerFetcher(name, key, fetcher);
  return async (symbol) => {
    const [from = "", to = ""] = symbol.split(":");
    const body = await getJson(fetcher, `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${encodeURIComponent(key)}`) as { "Realtime Currency Exchange Rate"?: Record<string, string> };
    const quote = body["Realtime Currency Exchange Rate"] ?? {};
    const price = positive(quote["5. Exchange Rate"]);
    const refreshed = quote["6. Last Refreshed"];
    const asOf = refreshed && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(refreshed) ? `${refreshed.replace(" ", "T")}Z` : undefined;
    return price ? { price, ...(asOf ? { asOf } : {}) } : undefined;
  };
}

/** Build the configured provider, or undefined when QUOTE_PROVIDER=none or a keyed provider has no key. */
export function createQuoteProvider(config: RuntimeConfig, fetcher: Fetch = (input, init) => globalThis.fetch(input, init)): QuoteProvider | undefined {
  const name = config.quoteProvider;
  if (name === "none") return undefined;
  if (name !== "stooq" && !config.quoteApiKey) return undefined;
  const fetchQuote = providerFetcher(name, config.quoteApiKey, fetcher);
  const fetchFx = fxFetcher(name, config.quoteApiKey, fetcher);
  const fetchHistory = historyFetcher(name, config.quoteApiKey, fetcher);
  const cache = new Map<string, { expiresAt: number; quote: ExternalQuote | undefined }>();
  const historyCache = new Map<string, { expiresAt: number; history: PriceHistory | undefined; failure?: string }>();
  const fxCache = new Map<string, { expiresAt: number; rate: ExternalFxRate | undefined }>();

  /** A rate between two ISO currencies, from the provider or, unless `fresh`, the cache. */
  const pairRate = async (from: string, to: string, fresh = false): Promise<ExternalFxRate | undefined> => {
    const symbol = fxSymbol(name, from, to);
    if (!symbol) return undefined;
    const cached = fxCache.get(symbol);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.rate;
    let rate: ExternalFxRate | undefined;
    try {
      const result = await fetchFx(symbol);
      if (result) rate = { from, to, rate: result.price, asOf: result.asOf ?? new Date().toISOString(), source: name };
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot FX rate failed", provider: name, symbol, error: error instanceof Error ? error.message : String(error) }));
    }
    // A fresh read that failed leaves the cache as it was, for the lookups that can use a recent rate.
    if (rate || !fresh) fxCache.set(symbol, { expiresAt: Date.now() + CACHE_MS, rate });
    return rate;
  };

  const mapping = (instrument: Instrument) => {
    const mapped = config.quoteSymbols.get(instrument.ticker.toUpperCase());
    return mapped ? symbolScale(mapped) : undefined;
  };
  const symbolFor = (instrument: Instrument) => {
    const mapped = mapping(instrument);
    if (mapped) return mapped.symbol;
    const us = usSymbol(instrument.ticker);
    if (!us) return undefined;
    return name === "stooq" ? `${us}.US` : us;
  };

  return {
    name,
    symbolFor,
    hasFxRates: fxSymbol(name, "EUR", "USD") !== undefined,
    ...(fetchHistory ? {
      async history(instrument: Instrument, from: Date) {
        const symbol = symbolFor(instrument);
        if (!symbol) return undefined;
        const factor = mapping(instrument)?.factor ?? 1;
        const start = isoDay(from);
        const key = `${symbol}*${factor}:${start}`;
        const cached = historyCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          if (cached.failure) throw new Error(cached.failure);
          return cached.history;
        }
        let history: PriceHistory | undefined;
        let failure: string | undefined;
        try {
          // One close per day, oldest first, from the start asked for.
          const byDay = new Map((await fetchHistory(symbol, from)).filter((point) => point.date >= start).map((point) => [point.date, Math.round(point.close * factor * 1e6) / 1e6]));
          const points = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
          if (points.length >= 2) history = { source: name, symbol, ...(factor === 1 ? {} : { factor }), points };
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ message: "TradePilot price history failed", provider: name, symbol, error: failure }));
        }
        // The start day is part of the key, so expired entries go rather than piling up day after day.
        for (const [entry, value] of historyCache) if (value.expiresAt <= Date.now()) historyCache.delete(entry);
        // A miss is kept only briefly, so a chart opened again soon after a failure asks again.
        historyCache.set(key, { expiresAt: Date.now() + (history ? HISTORY_CACHE_MS : CACHE_MS), history, ...(failure ? { failure } : {}) });
        if (failure) throw new Error(failure);
        return history;
      },
    } : {}),
    async quote(instrument, options) {
      const symbol = symbolFor(instrument);
      if (!symbol) return undefined;
      const factor = mapping(instrument)?.factor ?? 1;
      const key = `${symbol}*${factor}`;
      const cached = cache.get(key);
      if (!options?.fresh && cached && cached.expiresAt > Date.now()) return cached.quote;
      let quote: ExternalQuote | undefined;
      try {
        const result = await fetchQuote(symbol);
        if (result) quote = { ticker: instrument.ticker, symbol, price: Math.round(result.price * factor * 1e6) / 1e6, asOf: result.asOf ?? new Date().toISOString(), source: name };
      } catch (error) {
        console.error(JSON.stringify({ message: "TradePilot quote failed", provider: name, symbol, error: error instanceof Error ? error.message : String(error) }));
      }
      if (quote || !options?.fresh) cache.set(key, { expiresAt: Date.now() + CACHE_MS, quote });
      return quote;
    },
    async fxRate(from, to, options) {
      const source = from.toUpperCase();
      const target = to.toUpperCase();
      if (!/^[A-Z]{3}$/.test(source) || !/^[A-Z]{3}$/.test(target) || source === target) return undefined;
      // Pence are quoted as pounds: 1 GBP = 100 GBX.
      const base = source === "GBX" ? "GBP" : source;
      const quote = target === "GBX" ? "GBP" : target;
      const scale = (target === "GBX" ? 100 : 1) / (source === "GBX" ? 100 : 1);
      if (base === quote) return { from: source, to: target, rate: scale, asOf: new Date().toISOString(), source: name };
      const rate = await pairRate(base, quote, !!options?.fresh);
      return rate ? { ...rate, from: source, to: target, rate: rate.rate * scale } : undefined;
    },
  };
}
