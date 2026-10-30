// Risk by holding for the allocation: a year of each holding's daily closes, as the holding page reads them (one
// cached read each), turned into weekly returns by holdingRiskOf. The largest holdings are read first, a few at a
// time, for a few seconds at most; the rest are read on in the background and measured on the next read. Instruments
// not held can be measured beside them, for the covariance at targets that would buy them.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AllocationAnalysis, HoldingCovariance, HoldingWeight } from "../shared/history.js";
import { holdingRiskOf, MIN_WEEKS, type HoldingRiskInput } from "../shared/holding-risk.js";
import { benchmarkInstrument } from "./benchmark.js";
import { asStructuredError } from "./errors.js";
import { eachLimited, settleWithin, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";

const DAY_MS = 86_400_000;
/** Instruments whose closes are read at once; each read is cached by the price history. */
const CONCURRENCY = 4;
/** The reads are waited for this long in all; one still running then is left to fill the cache. */
const READ_BUDGET_MS = 5000;
/** Closes reaching fewer days back than this cannot give more than MIN_WEEKS weekly returns: not worth a provider's call. */
const MIN_DAYS = (MIN_WEEKS + 2) * 7;
/** Misses that are the quote provider's, not the holding's: when every holding has one, it is said once. */
const PROVIDER_MISSES = new Set(["provider", "plan"]);

export interface HoldingRiskDeps {
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** How long the reads are waited for; the default suits a tool call. */
  budgetMs?: number;
  /** Handed the holdings measured and their covariance, which the result leaves out (holdingRiskOf). */
  onCovariance?: (covariance: HoldingCovariance) => void;
  /**
   * Instruments not held to measure beside the holdings, for the covariance alone (targets that would buy them): read
   * after the holdings, within the same wait, and only with `onCovariance`.
   */
  alongside?: readonly string[];
  /** The quote provider's price of an instrument not held, where the sample account's path of closes ends. */
  quoteOf?: (instrument: Instrument) => Promise<number | undefined>;
  /** The benchmark (BENCHMARK) to read each holding's beta against: read after the holdings, within the same wait. */
  benchmark?: string;
}

type Missing = NonNullable<AllocationAnalysis["riskMissing"]>[number];
type Read = { points: HoldingRiskInput["points"] } | Omit<Missing, "ticker">;

/** The holdings' risk, or why there is none, and the holdings whose closes could not be read. */
export async function readHoldingRisk(deps: HoldingRiskDeps, _environment: TradingEnvironment, holdings: HoldingWeight[], read: { positions: Position[]; instruments: Instrument[] }, now = new Date()):
  Promise<Pick<AllocationAnalysis, "risk" | "riskProblem" | "riskMissing">> {
  const valued = holdings.filter((holding) => holding.value > 0).sort((a, b) => b.value - a.value);
  if (valued.length < 2) return { riskProblem: "Risk by holding needs two holdings or more." };
  const priceHistory = deps.priceHistory;
  if (!priceHistory) return { riskProblem: "No quote provider is configured (QUOTE_PROVIDER), so there are no closes to measure the holdings' risk from." };
  const listed = new Map(read.instruments.map((instrument) => [instrument.ticker, instrument]));
  // The benchmark, a US fund Trading 212 does not list included (its closes come from the quote provider alone).
  // An empty list is one that could not be read: only an explicit US ticker (SPY_US_EQ) is then taken for a US fund.
  const found = deps.benchmark ? benchmarkInstrument(read.instruments.length ? read.instruments : undefined, deps.benchmark) : undefined;
  const market = found && "instrument" in found ? found.instrument : undefined;
  if (market && !listed.has(market.ticker)) listed.set(market.ticker, market);
  const positions = new Map(read.positions.flatMap((position) => (position.instrument?.ticker ? [[position.instrument.ticker, position] as const] : [])));
  // A year back from the start of today (UTC), as the holding page and the gains ask: one cached read.
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);
  // A held instrument's closes are checked against Trading 212's price; one not held ends at the provider's quote.
  const requestFor = (ticker: string): PriceHistoryRequest | undefined => {
    const position = positions.get(ticker);
    const instrument = listed.get(ticker) ?? position?.instrument;
    return instrument && { instrument, from, minDays: MIN_DAYS, ...(position?.currentPrice ? { last: position.currentPrice } : deps.quoteOf ? { quote: deps.quoteOf(instrument) } : {}) };
  };
  const ask = (request: PriceHistoryRequest) => priceHistory(request)
    .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
  const later = async (ticker: string): Promise<Read> => ({ reason: "later", problem: `${ticker}'s closes were not read in time; they are read now for the next read.` });
  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const started = new Set<string>();
  const readOne = async (ticker: string): Promise<Read> => {
    if (!listed.has(ticker) && !positions.has(ticker)) return { reason: "data", problem: `Trading 212 does not list ${ticker} at the moment.` };
    if (Date.now() >= deadline) return later(ticker);
    const request = requestFor(ticker)!;
    started.add(ticker);
    // Waited for until the deadline only; a read that runs on fills the cache for the next one.
    const result = await settleWithin(ask(request), Math.max(0, deadline - Date.now()));
    if (!result || ("late" in result && result.late)) return later(ticker);
    return "prices" in result ? { points: result.prices.points } : { reason: result.missing, problem: result.problem };
  };
  // Instruments not held, for the covariance alone: after the holdings, which the risk on screen needs first.
  const held = new Set([...holdings.map((holding) => holding.ticker), ...positions.keys()]);
  // The benchmark after the holdings, unless it is one of them; before the instruments for the covariance alone, and
  // read once when it is one of those too.
  const marketRead = market && !valued.some((holding) => holding.ticker === market.ticker) ? [market.ticker] : [];
  const besides = deps.onCovariance ? [...new Set(deps.alongside ?? [])].filter((ticker) => !held.has(ticker) && !marketRead.includes(ticker)) : [];
  const marketBeside = !!deps.onCovariance && marketRead.length > 0 && (deps.alongside ?? []).includes(marketRead[0]!) && !held.has(marketRead[0]!);
  const tickers = [...valued.map((holding) => holding.ticker), ...marketRead, ...besides];
  const results = await eachLimited(tickers, CONCURRENCY, deadline, readOne, later);
  // The instruments not reached are read now, a few at a time, without waiting: the next read finds them cached.
  const unread = tickers.filter((ticker) => !started.has(ticker)).flatMap((ticker) => requestFor(ticker) ?? []);
  if (unread.length) void eachLimited(unread, CONCURRENCY, Infinity, ask, ask);
  const inputs: HoldingRiskInput[] = [];
  const missing: Missing[] = [];
  valued.forEach((holding, index) => {
    const result = results[index]!;
    if ("points" in result) inputs.push({ ticker: holding.ticker, value: holding.value, points: result.points });
    else missing.push({ ticker: holding.ticker, reason: result.reason, problem: result.problem });
  });
  const alongside: Array<Pick<HoldingRiskInput, "ticker" | "points">> = [];
  const unmeasured: NonNullable<HoldingCovariance["unmeasured"]> = [];
  const marketResult = marketRead.length ? results[valued.length] : undefined;
  const marketPoints = market && (marketResult ? ("points" in marketResult ? marketResult.points : undefined) : inputs.find((input) => input.ticker === market.ticker)?.points);
  if (marketBeside && marketResult) {
    if ("points" in marketResult) alongside.push({ ticker: market!.ticker, points: marketResult.points });
    else unmeasured.push({ ticker: market!.ticker, reason: marketResult.reason });
  }
  besides.forEach((ticker, index) => {
    const result = results[valued.length + marketRead.length + index]!;
    if ("points" in result) alongside.push({ ticker, points: result.points });
    else unmeasured.push({ ticker, reason: result.reason });
  });
  // The covariance names the instruments not held it leaves out, the ones not read with the ones it could not measure.
  const onCovariance = deps.onCovariance && ((found: HoldingCovariance) => {
    const left = [...unmeasured, ...(found.unmeasured ?? [])];
    deps.onCovariance!({ ...found, ...(left.length ? { unmeasured: left } : {}) });
  });
  // No provider, or a plan without a year of closes: one reason for every holding, said once.
  if (!inputs.length && missing.length && missing.every((item) => PROVIDER_MISSES.has(item.reason))) {
    return { riskProblem: `It needs a year of daily closes from the quote provider. ${missing[0]!.problem}` };
  }
  const risk = holdingRiskOf(inputs, now.toISOString().slice(0, 10), valued.reduce((sum, holding) => sum + holding.value, 0), onCovariance, alongside,
    market && marketPoints ? { ticker: market.ticker, points: marketPoints } : undefined);
  return {
    ...(risk ? { risk } : { riskProblem: inputs.length < 2
      ? "Fewer than two holdings have daily closes to measure."
      : `The holdings have too few weeks of closes in common (more than ${MIN_WEEKS} weekly returns are needed), their closes jump as across a change of unit, or they did not move.` }),
    ...(missing.length ? { riskMissing: missing } : {}),
  };
}
