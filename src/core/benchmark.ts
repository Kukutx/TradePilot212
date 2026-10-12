// The benchmark beside the time-weighted return: an index fund's closes over the same days, so the return reads
// against what the market did. Its return is a ratio of its own closes, so it needs no unit check; it is in the
// benchmark's currency.

import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import type { BenchmarkOption, BenchmarkReturn, PerformanceSummary, ReturnPoint } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import type { RuntimeConfig } from "./config.js";
import type { PriceHistoryRequest, PriceHistoryResult } from "./price-history.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import type { Watchlist } from "./watchlist.js";

const DAY_MS = 86_400_000;
/** The first close must be at most this many days before the first recorded day, else the start is not covered. */
const START_SLACK_DAYS = 7;
/** Choices the widget offers: the default, then ETFs held and on the watchlist. */
const MAX_OPTIONS = 8;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
/** Names for the US funds most often used as a benchmark, when Trading 212 does not list them. */
const US_FUNDS: Record<string, string> = {
  SPY: "SPDR S&P 500 ETF",
  VOO: "Vanguard S&P 500 ETF",
  QQQ: "Invesco QQQ (Nasdaq-100)",
  VT: "Vanguard Total World Stock ETF",
  URTH: "iShares MSCI World ETF",
};

/**
 * The benchmark's return on each day of `series`, from its close on or before that day against its close on or
 * before the first day. Undefined when its closes start after the first day (a week's slack for holidays).
 */
export function benchmarkReturns(series: ReturnPoint[], points: PricePoint[]): { return: number; series: ReturnPoint[] } | undefined {
  const first = series[0];
  if (!first || series.length < 2) return undefined;
  let index = -1;
  const closeOn = (date: string) => {
    while (index + 1 < points.length && points[index + 1]!.date <= date) index++;
    return index >= 0 ? points[index]! : undefined;
  };
  const base = closeOn(first.date);
  if (!base || !(base.close > 0) || Date.parse(`${first.date}T00:00:00Z`) - Date.parse(`${base.date}T00:00:00Z`) > START_SLACK_DAYS * DAY_MS) return undefined;
  const out = series.map((point) => ({ date: point.date, return: round(closeOn(point.date)!.close / base.close - 1) }));
  return { return: out[out.length - 1]!.return, series: out };
}

/** A Trading 212 instrument for the benchmark, or a US one Trading 212 does not list (quote providers map US tickers). */
function benchmarkInstrument(instruments: Instrument[], query: string): Instrument {
  try {
    return resolveInstrumentFromList(instruments, query);
  } catch (error) {
    const ticker = query.trim().toUpperCase().replace(/_US_EQ$/, "");
    if (/^[A-Z][A-Z.]{0,5}$/.test(ticker)) return { ticker: `${ticker}_US_EQ`, name: US_FUNDS[ticker] ?? ticker, shortName: ticker, currencyCode: "USD", type: "ETF" };
    throw error;
  }
}

const option = (instrument: Instrument): BenchmarkOption => ({
  ticker: instrument.ticker,
  ...(instrument.name && instrument.name !== instrument.shortName ? { name: instrument.name } : {}),
  ...(instrument.shortName ? { shortName: instrument.shortName } : {}),
});

export interface BenchmarkDeps {
  config: Pick<RuntimeConfig, "benchmark" | "sampleData">;
  trading: Pick<TradingService, "instruments" | "positions" | "externalQuote">;
  watchlist?: Pick<Watchlist, "list">;
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
}

/**
 * The benchmark fields of a performance summary: the comparison (`choice` overrides BENCHMARK; "none" leaves it
 * out), or why there is none, and the instruments the widget offers to compare with.
 */
export async function compareWithBenchmark(deps: BenchmarkDeps, environment: TradingEnvironment, summary: PerformanceSummary, choice?: string):
  Promise<Pick<PerformanceSummary, "benchmark" | "benchmarkTicker" | "benchmarkMissing" | "benchmarkProblem" | "benchmarkOptions">> {
  if (!summary.timeWeighted || !deps.priceHistory) return {};
  const wanted = choice?.trim() || deps.config.benchmark;
  const instruments = await deps.trading.instruments(environment).catch((): Instrument[] => []);
  const [positions, watched] = await Promise.all([
    deps.trading.positions(environment).catch(() => []),
    deps.watchlist?.list(environment).catch(() => []) ?? [],
  ]);
  const listed = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
  const funds = [...positions.map((position) => position.instrument?.ticker), ...watched.map((item) => item.ticker)]
    .flatMap((ticker) => { const instrument = ticker ? listed.get(ticker) : undefined; return instrument?.type === "ETF" ? [instrument] : []; });
  const lookup = (query: string) => { try { return benchmarkInstrument(instruments, query); } catch { return undefined; } };
  const fallback = deps.config.benchmark ? lookup(deps.config.benchmark) : undefined;
  const none = !wanted || /^none$/i.test(wanted);
  const instrument = none ? undefined : lookup(wanted);
  const seen = new Set<string>();
  const benchmarkOptions = [fallback, instrument, ...funds]
    .filter((item): item is Instrument => !!item && !seen.has(item.ticker) && !!seen.add(item.ticker))
    .slice(0, MAX_OPTIONS).map(option);
  const offered = benchmarkOptions.length ? { benchmarkOptions } : {};
  if (none) return offered;
  if (!instrument) return { ...offered, benchmarkMissing: "symbol", benchmarkProblem: `Trading 212 lists no instrument ${wanted}, and it is not a US symbol.` };

  const from = new Date(Date.parse(`${summary.timeWeighted.from}T00:00:00Z`) - START_SLACK_DAYS * DAY_MS);
  // The sample account draws its funds' closes through its own price, offline.
  const read = await deps.priceHistory({
    instrument,
    from,
    ...(deps.config.sampleData ? { quote: deps.trading.externalQuote(instrument).then((quote) => quote?.price).catch(() => undefined) } : {}),
  }).catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: error instanceof Error ? error.message : String(error) }));
  const tried = { ...offered, benchmarkTicker: instrument.ticker };
  if (!("prices" in read)) return { ...tried, benchmarkMissing: read.missing, benchmarkProblem: read.problem };
  const compared = benchmarkReturns(summary.timeWeighted.series, read.prices.points);
  if (!compared) {
    return {
      ...tried,
      benchmarkMissing: "data",
      benchmarkProblem: `${read.prices.source}'s closes for ${read.prices.symbol ?? instrument.ticker} start on ${read.prices.points[0]?.date}, after the first recorded day (${summary.timeWeighted.from}).`,
    };
  }
  return {
    ...tried,
    benchmark: {
      ...option(instrument),
      ...(instrument.currencyCode ? { currencyCode: instrument.currencyCode } : {}),
      source: read.prices.source,
      ...(read.prices.symbol ? { symbol: read.prices.symbol } : {}),
      ...compared,
    } satisfies BenchmarkReturn,
  };
}
