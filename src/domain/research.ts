import type { TradeIdea } from "./trading.js";

export interface ResearchAudit {
  kind: "research_audit";
  completenessPercent: number;
  analysisFreshness: "current" | "stale" | "unknown" | "future";
  referencePriceFreshness: "current" | "stale" | "unknown" | "future" | "not_applicable";
  traceableLinks: number;
  warningMessages: string[];
  claimVerification: "not_performed";
}

/** Evidence completeness measures documentation ONLY; it never verifies an AI claim. */
export function auditResearchIdea(candidate: TradeIdea, now = Date.now()): ResearchAudit {
  function freshness(value: string | undefined, thresholdMs: number):
    "current" | "stale" | "unknown" | "future" {
    const timestamp = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp)) return "unknown";
    if (timestamp > now + 5 * 60_000) return "future";
    return now - timestamp > thresholdMs ? "stale" : "current";
  }
  const horizonWindow: Record<TradeIdea["horizon"], number> = {
    short: 24 * 3600_000, medium: 7 * 86400_000, long: 30 * 86400_000,
  };
  const analysisFreshness = freshness(candidate.analysisAsOf, horizonWindow[candidate.horizon]);
  const referencePriceFreshness = candidate.action === "watch" ? "not_applicable"
    : freshness(candidate.referencePriceAt, 5 * 60_000);
  const hasTraceableUrl = (source: string) => {
    try {
      const url = new URL(source);
      return url.protocol === "https:" && !url.username && !url.password &&
        url.hostname.includes(".") && !url.hostname.endsWith(".local") &&
        !/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(url.hostname);
    } catch { return false; }
  };
  const sourceLinks = (candidate.sources ?? []).filter(hasTraceableUrl).length;
  const completeness =
    (candidate.thesis?.trim() ? 10 : 0) +
    (candidate.catalysts?.some(x => x.trim()) ? 10 : 0) +
    (candidate.risks?.some(x => x.trim()) ? 20 : 0) +
    (candidate.counterCase?.trim() ? 15 : 0) +
    (analysisFreshness === "current" ? 20 : 0) +
    (sourceLinks > 0 ? 25 : 0);
  const warnings: string[] = [];
  if (!sourceLinks)
    warnings.push("No traceable HTTPS source URL; factual claims are not independently verifiable from this card.");
  if (sourceLinks > 0)
    warnings.push("Source links are model-supplied; their content and truth have not been independently verified.");
  if (analysisFreshness !== "current")
    warnings.push(`Research timestamp is ${analysisFreshness}; update the analysis before decisions.`);
  if (referencePriceFreshness !== "current" && referencePriceFreshness !== "not_applicable")
    warnings.push(`Suggested reference price timestamp is ${referencePriceFreshness}; this is not executable market data.`);
  if (!candidate.risks?.length || !candidate.counterCase?.trim())
    warnings.push("Missing risk discussion or counter-case; avoid treating the AI score as independent investment evidence.");
  return {
    kind: "research_audit",
    completenessPercent: completeness,
    analysisFreshness,
    referencePriceFreshness,
    traceableLinks: sourceLinks,
    warningMessages: warnings,
    claimVerification: "not_performed",
  };
}
