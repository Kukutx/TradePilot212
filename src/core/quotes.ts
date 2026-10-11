// External quotes for instruments you do not hold. Trading 212's Public API has no quote endpoint,
// so without this the broker only reports prices for held positions.
//
// Providers are pluggable (QUOTE_PROVIDER). The default, Stooq, is free and needs no account but is
// unofficial and best effort. Finnhub, Twelve Data and Alpha Vantage need a free key (QUOTE_API_KEY).
// Only US-listed instruments are mapped automatically; others need an explicit QUOTE_SYMBOLS entry,
// because exchange suffixes and price units (for example GBX pence) differ between providers.

import type { Instrument } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";

export type QuoteProviderName = "stooq" | "finnhub" | "twelvedata" | "alphavantage" | "none";
export const QUOTE_PROVIDERS: QuoteProviderName[] = ["stooq", "finnhub", "twelvedata", "alphavantage", "none"];

export interface ExternalQuote {
  ticker: string;
  symbol: string;
  price: number;
  /** When the provider says the price is from; otherwise when it was fetched. */
  asOf: string;
  source: QuoteProviderName;
}

export interface ExternalFxRate {
  from: string;
  to: string;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  asOf: string;
  source: QuoteProviderName;
}

export interface QuoteProvider {
  name: QuoteProviderName;
  /** The provider symbol for an instrument, or undefined when it cannot be mapped safely. */
  symbolFor(instrument: Instrument): string | undefined;
  quote(instrument: Instrument): Promise<ExternalQuote | undefined>;
  /** An exchange rate, for currencies none of your holdings price; undefined when the provider has none. */
  fxRate(from: string, to: string): Promise<ExternalFxRate | undefined>;
}

const CACHE_MS = 60_000;

/** The plain US symbol of a Trading 212 US ticker, e.g. AAPL_US_EQ → AAPL, BRK.B_US_EQ → BRK.B. */
export function usSymbol(ticker: string): string | undefined {
  const match = /^([A-Z0-9.]+)_US_EQ$/.exec(ticker);
  return match?.[1];
}

/** Parse QUOTE_SYMBOLS, e.g. "VUSAl_EQ=VUSA.UK, SAPd_EQ=SAP.DE". Keys are exact Trading 212 tickers. */
export function parseSymbolMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const [ticker, symbol] = entry.split("=");
    if (!ticker || !symbol) throw new Error(`QUOTE_SYMBOLS entry "${entry}" must look like TICKER=SYMBOL`);
    map.set(ticker.trim().toUpperCase(), symbol.trim());
  }
  return map;
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
  const cache = new Map<string, { expiresAt: number; quote: ExternalQuote | undefined }>();
  const fxCache = new Map<string, { expiresAt: number; rate: ExternalFxRate | undefined }>();

  /** A rate between two ISO currencies, from the provider or the cache. */
  const pairRate = async (from: string, to: string): Promise<ExternalFxRate | undefined> => {
    const symbol = fxSymbol(name, from, to);
    if (!symbol) return undefined;
    const cached = fxCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.rate;
    let rate: ExternalFxRate | undefined;
    try {
      const result = await fetchFx(symbol);
      if (result) rate = { from, to, rate: result.price, asOf: result.asOf ?? new Date().toISOString(), source: name };
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot FX rate failed", provider: name, symbol, error: error instanceof Error ? error.message : String(error) }));
    }
    fxCache.set(symbol, { expiresAt: Date.now() + CACHE_MS, rate });
    return rate;
  };

  const symbolFor = (instrument: Instrument) => {
    const mapped = config.quoteSymbols.get(instrument.ticker.toUpperCase());
    if (mapped) return mapped;
    const us = usSymbol(instrument.ticker);
    if (!us) return undefined;
    return name === "stooq" ? `${us}.US` : us;
  };

  return {
    name,
    symbolFor,
    async quote(instrument) {
      const symbol = symbolFor(instrument);
      if (!symbol) return undefined;
      const cached = cache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) return cached.quote;
      let quote: ExternalQuote | undefined;
      try {
        const result = await fetchQuote(symbol);
        if (result) quote = { ticker: instrument.ticker, symbol, price: result.price, asOf: result.asOf ?? new Date().toISOString(), source: name };
      } catch (error) {
        console.error(JSON.stringify({ message: "TradePilot quote failed", provider: name, symbol, error: error instanceof Error ? error.message : String(error) }));
      }
      cache.set(symbol, { expiresAt: Date.now() + CACHE_MS, quote });
      return quote;
    },
    async fxRate(from, to) {
      const source = from.toUpperCase();
      const target = to.toUpperCase();
      if (!/^[A-Z]{3}$/.test(source) || !/^[A-Z]{3}$/.test(target) || source === target) return undefined;
      // Pence are quoted as pounds: 1 GBP = 100 GBX.
      const base = source === "GBX" ? "GBP" : source;
      const quote = target === "GBX" ? "GBP" : target;
      const scale = (target === "GBX" ? 100 : 1) / (source === "GBX" ? 100 : 1);
      if (base === quote) return { from: source, to: target, rate: scale, asOf: new Date().toISOString(), source: name };
      const rate = await pairRate(base, quote);
      return rate ? { ...rate, from: source, to: target, rate: rate.rate * scale } : undefined;
    },
  };
}
