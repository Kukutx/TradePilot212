// The benchmark beside the time-weighted return: an index fund's closes over the same days, so the return reads
// against what the market did. Its return is a ratio of its own closes, so it needs no unit check; it is in the
// benchmark's currency.

import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import type { BenchmarkOption, BenchmarkReturn, PerformanceSummary, ReturnPoint } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import { drawdownOf } from "../shared/drawdown.js";
import { benchmarkRiskOf } from "../shared/risk.js";
import type { RuntimeConfig } from "./config.js";
import { settleWithin, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import type { Watchlist } from "./watchlist.js";

const DAY_MS = 86_400_000;
/** The first close must be at most this many days before the first recorded day, else the start is not covered. */
const START_SLACK_DAYS = 7;
/** How long the comparison waits for Trading 212's instrument list and holdings. */
const LIST_WAIT_MS = 3000;
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
 * before the first day. Undefined when its closes start after the first day (a week's slack for holidays). Its risk
 * is read over the return's risk's days, up to and including `through`, and only with one.
 */
export function benchmarkReturns(series: ReturnPoint[], points: PricePoint[], through?: string): Pick<BenchmarkReturn, "return" | "series" | "drawdown" | "risk"> | undefined {
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
  const drawdown = drawdownOf(out);
  const risk = through ? benchmarkRiskOf(series, out, through) : undefined;
  return { return: out[out.length - 1]!.return, series: out, ...(drawdown ? { drawdown } : {}), ...(risk ? { risk } : {}) };
}

/**
 * The benchmark's instrument: Trading 212's, or a US fund Trading 212 does not list (quote providers map US tickers
 * themselves). A query Trading 212 matches several times, or one it cannot look up, says why instead.
 */
export function benchmarkInstrument(instruments: Instrument[] | undefined, query: string): { instrument: Instrument } | { problem: string } {
  const wanted = query.trim().toUpperCase();
  const us = /^[A-Z][A-Z.]{0,5}_US_EQ$/.test(wanted) ? wanted.replace(/_US_EQ$/, "") : undefined;
  const synthetic = (symbol: string) => ({ instrument: { ticker: `${symbol}_US_EQ`, name: US_FUNDS[symbol] ?? symbol, shortName: symbol, currencyCode: "USD", type: "ETF" } });
  if (!instruments) return us ? synthetic(us) : { problem: `Trading 212's instrument list could not be read, so ${query} could not be looked up; try again.` };
  try {
    return { instrument: resolveInstrumentFromList(instruments, query) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only a symbol Trading 212 does not list at all is taken for a US fund; an ambiguous one names its listings.
    const symbol = us ?? (/^[A-Z]{1,5}$/.test(wanted) ? wanted : undefined);
    return symbol && message.startsWith("No Trading 212 instrument matched") ? synthetic(symbol) : { problem: message };
  }
}

const option = (instrument: Instrument): BenchmarkOption => ({
  ticker: instrument.ticker,
  ...(instrument.name && instrument.name !== instrument.shortName ? { name: instrument.name } : {}),
  ...(instrument.shortName ? { shortName: instrument.shortName } : {}),
});

export interface BenchmarkDeps {
  config: Pick<RuntimeConfig, "benchmark" | "sampleData">;
  trading: Pick<TradingService, "instruments" | "cachedInstruments" | "positions" | "externalQuote">;
  watchlist?: Pick<Watchlist, "list">;
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
}

/**
 * The benchmark fields of a performance summary: the comparison (`choice` overrides BENCHMARK; "none" leaves it
 * out), or why there is none, and the instruments the widget offers to compare with. Without a comparison it asks
 * Trading 212 for nothing, offering what it already knows, so the choice can be turned back on.
 */
export async function compareWithBenchmark(deps: BenchmarkDeps, environment: TradingEnvironment, summary: PerformanceSummary, choice?: string, now = new Date()):
  Promise<Pick<PerformanceSummary, "benchmark" | "benchmarkChoice" | "benchmarkMissing" | "benchmarkProblem" | "benchmarkOptions">> {
  if (!summary.timeWeighted || !deps.priceHistory) return {};
  const wanted = choice?.trim() || deps.config.benchmark;
  const none = !wanted || /^none$/i.test(wanted);
  // The instrument list (cached ten minutes) and the holdings, at most a few seconds each: the comparison is optional.
  const [instruments, positions, watched] = await Promise.all([
    none ? Promise.resolve(deps.trading.cachedInstruments(environment)) : settleWithin(deps.trading.instruments(environment).catch(() => undefined), LIST_WAIT_MS),
    none ? Promise.resolve([]) : settleWithin(deps.trading.positions(environment).catch(() => []), LIST_WAIT_MS),
    deps.watchlist?.list(environment).catch(() => []) ?? [],
  ]);
  const listed = new Map((instruments ?? []).map((instrument) => [instrument.ticker, instrument]));
  const funds = [...(positions ?? []).map((position) => position.instrument?.ticker), ...watched.map((item) => item.ticker)]
    .flatMap((ticker) => { const instrument = ticker ? listed.get(ticker) : undefined; return instrument?.type === "ETF" ? [instrument] : []; });
  const lookup = (query: string) => { const found = benchmarkInstrument(instruments, query); return "instrument" in found ? found.instrument : undefined; };
  const fallback = deps.config.benchmark ? lookup(deps.config.benchmark) : undefined;
  const found = none ? undefined : benchmarkInstrument(instruments, wanted);
  const instrument = found && "instrument" in found ? found.instrument : undefined;
  const seen = new Set<string>();
  const benchmarkOptions = [fallback, instrument, ...funds]
    .filter((item): item is Instrument => !!item && !seen.has(item.ticker) && !!seen.add(item.ticker))
    .slice(0, MAX_OPTIONS).map(option);
  const offered = benchmarkOptions.length ? { benchmarkOptions } : {};
  if (none) return { ...offered, benchmarkChoice: "none" };
  if (!instrument) return { ...offered, benchmarkChoice: wanted, benchmarkMissing: "instrument", benchmarkProblem: found && "problem" in found ? found.problem : `No benchmark ${wanted}.` };

  // A year back at least, from the start of today (UTC) as the holding page's chart asks: periods share one read.
  const yearAgo = Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS;
  const from = new Date(Math.min(yearAgo, Date.parse(`${summary.timeWeighted.from}T00:00:00Z`) - START_SLACK_DAYS * DAY_MS));
  // The sample account draws its funds' closes through its own price, offline.
  const read = await deps.priceHistory({
    instrument,
    from,
    ...(deps.config.sampleData ? { quote: deps.trading.externalQuote(instrument).then((quote) => quote?.price).catch(() => undefined) } : {}),
  }).catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: error instanceof Error ? error.message : String(error) }));
  const tried = { ...offered, benchmarkChoice: instrument.ticker };
  if (!("prices" in read)) return { ...tried, benchmarkMissing: read.missing, benchmarkProblem: read.problem };
  const compared = benchmarkReturns(summary.timeWeighted.series, read.prices.points, summary.timeWeighted.risk?.to);
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
