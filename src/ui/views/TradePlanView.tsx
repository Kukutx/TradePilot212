import { useEffect, useState } from "react";
import type { EnrichedTradeCandidate, Horizon, TradePlanPayload } from "../../shared/contracts";
import type { MessageKey, SupportedLocale } from "../i18n";
import { DetailList, DetailSection, Icon, Metric } from "../components/common";
import { dateTime, money, num, time } from "../lib/format";
import type { Translator } from "../lib/messages";

export function TradePlanView({
  payload,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  payload: TradePlanPayload;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onTrade: (candidate: EnrichedTradeCandidate) => void;
}) {
  const [activeHorizon, setActiveHorizon] = useState<Horizon>("short");
  useEffect(() => {
    if (payload.candidates.some((candidate) => candidate.horizon === activeHorizon)) return;
    const first = (["short", "medium", "long"] as Horizon[]).find((horizon) => payload.candidates.some((candidate) => candidate.horizon === horizon));
    if (first) setActiveHorizon(first);
  }, [activeHorizon, payload.candidates]);
  const groups: Array<{ key: Horizon; label: string; hint: string }> = [
    { key: "short", label: t("short"), hint: t("shortHint") },
    { key: "medium", label: t("medium"), hint: t("mediumHint") },
    { key: "long", label: t("long"), hint: t("longHint") },
  ];
  const visible = payload.candidates.filter((candidate) => candidate.horizon === activeHorizon);
  const currency = payload.account?.currency ?? "EUR";
  return (
    <main className="contentStack">
      <section className="overviewPanel tradeOverview">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("tradePlan")}</span>
          <strong className="heroValue small">{payload.candidates.length} {t("candidates")}</strong>
          <span className="overviewSubline">{t("account")} · {payload.environment.toUpperCase()}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("totalValue")} value={money(payload.account?.totalValue, currency, locale)} />
          <Metric label={t("availableCash")} value={money(payload.account?.cash?.availableToTrade, currency, locale)} />
          <Metric label={t("unrealizedPnL")} value={money(payload.account?.investments?.unrealizedProfitLoss, currency, locale)} />
          <Metric label={t("lastUpdated")} value={time(payload.timestamp, locale)} compact />
        </div>
      </section>

      <section className="dataPanel tradePanel">
        <div className="horizonTabs" role="tablist">
          {groups.map((group) => {
            const count = payload.candidates.filter((candidate) => candidate.horizon === group.key).length;
            return (
              <button key={group.key} type="button" role="tab" aria-selected={activeHorizon === group.key} className={activeHorizon === group.key ? "active" : ""} onClick={() => setActiveHorizon(group.key)}>
                <span>{group.label}</span><small>{group.hint}</small><b>{count}</b>
              </button>
            );
          })}
        </div>
        {visible.length === 0 ? <div className="emptyState compact">{t("candidates")} · 0</div> : (
          <div className="candidateGrid">
            {visible.map((candidate, index) => (
              <CandidateCard
                key={`${candidate.resolvedInstrument?.ticker ?? candidate.ticker ?? candidate.symbol}-${index}`}
                candidate={candidate}
                locale={locale}
                t={t}
                writeEnabled={writeEnabled}
                onTrade={onTrade}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export function CandidateCard({
  candidate,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  candidate: EnrichedTradeCandidate;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onTrade: (candidate: EnrichedTradeCandidate) => void;
}) {
  const instrument = candidate.resolvedInstrument;
  const actionKey: MessageKey = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  const riskKey: MessageKey = candidate.risk === "low" ? "low" : candidate.risk === "high" ? "high" : "mediumRisk";
  const actionClass = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  return (
    <article className="candidateCard">
      <div className="candidateTopline">
        <div className="candidateIdentity">
          <span className="assetAvatar">{(instrument?.shortName || candidate.symbol || candidate.ticker || candidate.name || "?").slice(0, 2).toUpperCase()}</span>
          <div><strong>{instrument?.shortName || candidate.symbol || candidate.ticker || candidate.name}</strong><small>{instrument?.ticker || candidate.ticker || "—"}</small></div>
        </div>
        <div className={`scoreRing ${candidate.score >= 80 ? "high" : candidate.score >= 65 ? "medium" : "low"}`}><strong>{candidate.score}</strong><span>{t("score")}</span></div>
      </div>
      <div className="candidateBadges">
        <span className={`actionBadge ${actionClass}`}>{t(actionKey)}</span>
        <span>{t("risk")} · {t(riskKey)}</span>
        {candidate.referencePrice && <span>{t("reference")} · {money(candidate.referencePrice, instrument?.currencyCode ?? "USD", locale)}</span>}
      </div>
      <p className="candidateRationale">{candidate.rationale}</p>
      {(candidate.thesis || candidate.catalysts?.length || candidate.risks?.length || candidate.counterCase || candidate.sources?.length) && (
        <details className="candidateDetails">
          <summary>{t("details")}</summary>
          <div className="candidateDetailBody">
            {candidate.thesis && <DetailSection title={t("thesis")} text={candidate.thesis} />}
            {!!candidate.catalysts?.length && <DetailList title={t("catalysts")} items={candidate.catalysts} />}
            {!!candidate.risks?.length && <DetailList title={t("risksTitle")} items={candidate.risks} />}
            {candidate.counterCase && <DetailSection title={t("counterCase")} text={candidate.counterCase} />}
            {!!candidate.sources?.length && <DetailList title={t("sources")} items={candidate.sources} />}
            {(candidate.analysisAsOf || candidate.referencePriceAt) && (
              <div className="candidateFreshness">
                {candidate.analysisAsOf && <span>{t("analysisAsOf")} · {dateTime(candidate.analysisAsOf, locale)}</span>}
                {candidate.referencePriceAt && <span>{t("referenceAsOf")} · {dateTime(candidate.referencePriceAt, locale)}</span>}
              </div>
            )}
          </div>
        </details>
      )}
      {candidate.resolutionError && <div className="inlineError">{candidate.resolutionError}</div>}
      {(candidate.heldQuantity !== undefined || candidate.availableToSell !== undefined) && (
        <div className="candidateHolding"><span>{t("holding")}</span><strong>{num(candidate.heldQuantity, locale)}</strong><span>· {t("availableToSell")}</span><strong>{num(candidate.availableToSell, locale)}</strong></div>
      )}
      <button
        className={`tradeButton ${actionClass}`}
        type="button"
        disabled={!writeEnabled || candidate.action === "watch" || !instrument}
        onClick={() => onTrade(candidate)}
      >
        <span>{candidate.action === "watch" ? t("keepWatching") : candidate.action === "sell" ? t("prepareSell") : t("prepareBuy")}</span>
        {candidate.action !== "watch" && <Icon name="arrow" />}
      </button>
    </article>
  );
}
