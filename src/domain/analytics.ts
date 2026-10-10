import type { Exposure, PortfolioAnalysis, PortfolioSnapshot, RuleEvaluation, Scenario, WatchRule } from "./types.js";

function percent(numerator: number | null, denominator: number): number | null {
  if (numerator === null || !Number.isFinite(numerator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}
function rounded(value: number): number { return Math.round(value * 100) / 100; }

export function analyzePortfolio(snapshot: PortfolioSnapshot): PortfolioAnalysis {
  const { account, holdings } = snapshot;
  const allValued = holdings.every(h => h.valueInAccountCurrency !== null);
  const priced = holdings.filter(h => h.valueInAccountCurrency !== null);
  const covered = priced.reduce((total, holding) => total + holding.valueInAccountCurrency!, 0);
  const investmentValue = account.investmentValue;
  const coverage = investmentValue > 0 ? percent(covered, investmentValue) : holdings.length === 0 ? 100 : null;
  // Unknown holdings mean the top-5 and HHI are not portfolio-wide metrics.
  const fullyCovered = allValued && coverage !== null && Math.abs(coverage - 100) <= 2;
  const exposures: Exposure[] = holdings.map(holding => ({
    ticker: holding.ticker,
    name: holding.name,
    value: holding.valueInAccountCurrency,
    weightPercent: percent(holding.valueInAccountCurrency, account.totalValue),
    source: holding.valueProvenance,
  })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const largestPosition = fullyCovered && exposures.length > 0 ? exposures[0]!.weightPercent : null;
  const hhi = fullyCovered && account.totalValue > 0
    ? rounded(exposures.reduce((sum, holding) => sum + (holding.weightPercent ?? 0) ** 2, 0))
    : null;
  const cash = percent(account.availableCash, account.totalValue);
  const limitations = [...snapshot.notes];
  const alerts: string[] = [];
  if (!fullyCovered) limitations.push("Portfolio-wide concentration is unavailable: position values do not fully reconcile in account currency.");
  if (largestPosition !== null && largestPosition >= 35) alerts.push("One position represents at least 35% of total account value.");
  if (cash !== null && cash < 5) alerts.push("Available cash is below 5% of total account value.");
  if (cash !== null && cash > 50) alerts.push("Available cash exceeds 50% of total account value.");
  if (account.unrealizedProfitLoss === null) limitations.push("Broker did not supply a reliable unrealized P/L value.");
  if (snapshot.source === "sample") limitations.unshift("SYNTHETIC SAMPLE DATA — not a real Trading 212 account.");
  return {
    kind: "analysis", environment: snapshot.environment, source: snapshot.source, asOf: snapshot.asOf,
    accountCurrency: account.currency, exposureCoveragePercent: coverage,
    largestPositionPercent: largestPosition, cashPercent: cash, concentrationHhi: hhi,
    exposures, alerts, limitations,
  };
}

export function stressPortfolio(snapshot: PortfolioSnapshot, shockPercent: number): Scenario {
  if (!Number.isFinite(shockPercent) || shockPercent < -80 || shockPercent > 80)
    throw new Error("shockPercent must be between -80 and 80");
  const analysis = analyzePortfolio(snapshot);
  const complete = !analysis.limitations.some(x => x.includes("do not fully reconcile"));
  const change = complete ? rounded(snapshot.account.investmentValue * shockPercent / 100) : null;
  return {
    kind: "scenario", environment: snapshot.environment, source: snapshot.source, asOf: snapshot.asOf,
    shockPercent, currency: snapshot.account.currency,
    hypotheticalPortfolioChange: change,
    hypotheticalPortfolioValue: change === null ? null : rounded(snapshot.account.totalValue + change),
    assumptions: [
      "A uniform hypothetical price move on all valued holdings; cash is held constant.",
      "No taxes, spreads, currency changes, fees, rebalancing or additional deposits.",
      "This is arithmetic stress testing, not a market forecast or recommended trade.",
      ...(change === null ? ["Incomplete currency/value coverage prevents a meaningful total estimate."] : []),
      ...(snapshot.source === "sample" ? ["Synthetic sample portfolio only."] : []),
    ],
  };
}

export function evaluateRule(rule: WatchRule, snapshot: PortfolioSnapshot, analysis: PortfolioAnalysis): RuleEvaluation {
  let observed: number | null;
  if (rule.kind === "cash_below") observed = analysis.cashPercent;
  else if (rule.kind === "largest_position_above") observed = analysis.largestPositionPercent;
  else observed = percent(snapshot.account.unrealizedProfitLoss, snapshot.account.totalValue);

  if (observed === null) return {
    rule, status: "unavailable", observedPercent: null,
    explanation: "Required reliable, currency-consistent metric is unavailable.",
  };
  const triggered = rule.kind === "largest_position_above"
    ? observed >= rule.thresholdPercent
    : observed <= rule.thresholdPercent;
  return {
    rule, status: triggered ? "triggered" : "clear",
    observedPercent: observed,
    explanation: `${rule.kind}: observed ${observed}% vs ${rule.thresholdPercent}% threshold.`,
  };
}
