// Risk by holding for the allocation: a year of each holding's daily closes, as the holding page reads them (one
// cached read each), turned into weekly returns by holdingRiskOf. The largest holdings are read first, a few at a
// time, for at most a few seconds; the rest are named and measured on the next read, once the first are cached.

import type { Instrument, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AllocationAnalysis, HoldingWeight } from "../shared/history.js";
import { holdingRiskOf, MIN_WEEKS, type HoldingRiskInput } from "../shared/holding-risk.js";
import { asStructuredError } from "./errors.js";
import { eachLimited, type PriceHistoryRequest, type PriceHistoryResult } from "./price-history.js";

const DAY_MS = 86_400_000;
/** Instruments whose closes are read at once; each read is cached by the price history. */
const CONCURRENCY = 4;
/** No new read of closes starts after this long. */
const READ_BUDGET_MS = 5000;

export interface HoldingRiskDeps {
  priceHistory?: (request: PriceHistoryRequest) => Promise<PriceHistoryResult>;
  /** How long new reads of closes are started for; the default suits a tool call. */
  budgetMs?: number;
}

type Read = { points: HoldingRiskInput["points"] } | { reason: NonNullable<AllocationAnalysis["riskMissing"]>[number]["reason"]; problem: string };

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
  const deadline = Date.now() + (deps.budgetMs ?? READ_BUDGET_MS);
  const readOne = async (holding: HoldingWeight): Promise<Read> => {
    const position = positions.get(holding.ticker);
    const instrument = listed.get(holding.ticker) ?? position?.instrument;
    if (!instrument) return { reason: "data", problem: `Trading 212 does not list ${holding.ticker} at the moment.` };
    const result = await priceHistory({ instrument, from, ...(position?.currentPrice ? { last: position.currentPrice } : {}) })
      .catch((error: unknown): PriceHistoryResult => ({ missing: "data", problem: asStructuredError(error).message }));
    return "prices" in result ? { points: result.prices.points } : { reason: result.missing, problem: result.problem };
  };
  const later = async (holding: HoldingWeight): Promise<Read> => ({ reason: "later", problem: `${holding.ticker}'s closes are asked for on the next read: this one ran out of time.` });
  const results = await eachLimited(valued, CONCURRENCY, deadline, readOne, later);
  const inputs: HoldingRiskInput[] = [];
  const missing: NonNullable<AllocationAnalysis["riskMissing"]> = [];
  valued.forEach((holding, index) => {
    const result = results[index]!;
    if ("points" in result) inputs.push({ ticker: holding.ticker, value: holding.value, points: result.points });
    else missing.push({ ticker: holding.ticker, reason: result.reason, problem: result.problem });
  });
  const risk = holdingRiskOf(inputs, now.toISOString().slice(0, 10), valued.reduce((sum, holding) => sum + holding.value, 0));
  return {
    ...(risk ? { risk } : { riskProblem: inputs.length < 2
      ? "Fewer than two holdings have daily closes to measure."
      : `The holdings have too few weeks of closes in common (more than ${MIN_WEEKS} are needed), or did not move.` }),
    ...(missing.length ? { riskMissing: missing } : {}),
  };
}
