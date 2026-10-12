// Risk by holding for the allocation: a year of each holding's daily closes, as the holding page reads them (one
// cached read each), turned into weekly returns by holdingRiskOf. The largest holdings are read first, a few at a
// time, for a few seconds at most; the rest are read on in the background and measured on the next read.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AllocationAnalysis, HoldingWeight } from "../shared/history.js";
import { holdingRiskOf, MIN_WEEKS, type HoldingRiskInput } from "../shared/holding-risk.js";
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
  const positions = new Map(read.positions.flatMap((position) => (position.instrument?.ticker ? [[position.instrument.ticker, position] as const] : [])));
  // A year back from the start of today (UTC), as the holding page and the gains ask: one cached read.
  const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS);
  const requestFor = (holding: HoldingWeight): PriceHistoryRequest | undefined => {
    const position = positions.get(holding.ticker);
    const instrument = listed.get(holding.ticker) ?? position?.instrument;
    return instrument && { instrument, from, minDays: MIN_DAYS, ...(position?.currentPrice ? { last: position.currentPrice } : {}) };
  };
  const ask = (request: PriceHistoryRequest) => priceHistory(request)
    .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
  const later = async (holding: HoldingWeight): Promise<Read> => ({ reason: "later", problem: `${holding.ticker}'s closes were not read in time; they are read now for the next read.` });
  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const started = new Set<string>();
  const readOne = async (holding: HoldingWeight): Promise<Read> => {
    const request = requestFor(holding);
    if (!request) return { reason: "data", problem: `Trading 212 does not list ${holding.ticker} at the moment.` };
    if (Date.now() >= deadline) return later(holding);
    started.add(holding.ticker);
    // Waited for until the deadline only; a read that runs on fills the cache for the next one.
    const result = await settleWithin(ask(request), Math.max(0, deadline - Date.now()));
    if (!result || ("late" in result && result.late)) return later(holding);
    return "prices" in result ? { points: result.prices.points } : { reason: result.missing, problem: result.problem };
  };
  const results = await eachLimited(valued, CONCURRENCY, deadline, readOne, later);
  // The holdings not reached are read now, a few at a time, without waiting: the next read finds them cached.
  const unread = valued.filter((holding) => !started.has(holding.ticker)).flatMap((holding) => requestFor(holding) ?? []);
  if (unread.length) void eachLimited(unread, CONCURRENCY, Infinity, ask, ask);
  const inputs: HoldingRiskInput[] = [];
  const missing: Missing[] = [];
  valued.forEach((holding, index) => {
    const result = results[index]!;
    if ("points" in result) inputs.push({ ticker: holding.ticker, value: holding.value, points: result.points });
    else missing.push({ ticker: holding.ticker, reason: result.reason, problem: result.problem });
  });
  // No provider, or a plan without a year of closes: one reason for every holding, said once.
  if (!inputs.length && missing.length && missing.every((item) => PROVIDER_MISSES.has(item.reason))) {
    return { riskProblem: `It needs a year of daily closes from the quote provider. ${missing[0]!.problem}` };
  }
  const risk = holdingRiskOf(inputs, now.toISOString().slice(0, 10), valued.reduce((sum, holding) => sum + holding.value, 0));
  return {
    ...(risk ? { risk } : { riskProblem: inputs.length < 2
      ? "Fewer than two holdings have daily closes to measure."
      : `The holdings have too few weeks of closes in common (more than ${MIN_WEEKS} weekly returns are needed), their closes jump as across a change of unit, or they did not move.` }),
    ...(missing.length ? { riskMissing: missing } : {}),
  };
}
