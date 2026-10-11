import { useEffect, useState } from "react";
import type { EnrichedTradeCandidate, Horizon, TradePlanPayload } from "../../shared/contracts";
import type { MessageKey, SupportedLocale } from "../i18n";
import { DetailList, DetailSection, Icon, Metric } from "../components/common";
import { dateTime, money, qty, signedClass, time } from "../lib/format";
import { instrumentCurrency, instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { countText, envLabel, type Translator } from "../lib/messages";

export function TradePlanView({
  payload,
  book,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  payload: TradePlanPayload;
  book?: InstrumentBook;
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
          <strong className="heroValue small">{countText("candidates", payload.candidates.length, t, locale)}</strong>
          <span className="overviewSubline">{t("account")} · {envLabel(payload.environment, t)}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("totalValue")} value={money(payload.account?.totalValue, currency, locale)} />
          <Metric label={t("availableCash")} value={money(payload.account?.cash?.availableToTrade, currency, locale)} />
          <Metric label={t("unrealizedPnL")} value={money(payload.account?.investments?.unrealizedProfitLoss, currency, locale, { signed: true })} tone={signedClass(payload.account?.investments?.unrealizedProfitLoss)} />
          <Metric label={t("lastUpdated")} value={time(payload.timestamp, locale)} compact />
        </div>
      </section>

      <section className="dataPanel tradePanel">
        <div className="horizonTabs" role="tablist" aria-label={t("tradePlan")}>
          {groups.map((group) => {
            const count = payload.candidates.filter((candidate) => candidate.horizon === group.key).length;
            return (
              <button key={group.key} type="button" role="tab" aria-selected={activeHorizon === group.key} className={activeHorizon === group.key ? "active" : ""} onClick={() => setActiveHorizon(group.key)}>
                <span className="horizonLabel"><span>{group.label}</span><b aria-label={countText("candidates", count, t, locale)}>{count}</b></span><small>{group.hint}</small>
              </button>
            );
          })}
        </div>
        {visible.length === 0 ? <div className="emptyState compact">{t("noCandidates")}</div> : (
          <div className="candidateGrid">
            {visible.map((candidate, index) => (
              <CandidateCard
                key={`${candidate.resolvedInstrument?.ticker ?? candidate.ticker ?? candidate.symbol}-${index}`}
                candidate={candidate}
                book={book}
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
  book,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  candidate: EnrichedTradeCandidate;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onTrade: (candidate: EnrichedTradeCandidate) => void;
}) {
  const instrument = candidate.resolvedInstrument;
  const actionKey: MessageKey = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  const riskKey: MessageKey = candidate.risk === "low" ? "low" : candidate.risk === "high" ? "high" : "mediumRisk";
  const actionClass = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  const ticker = instrument?.ticker || candidate.ticker;
  const label = ticker ? instrumentLabel(ticker, book, instrument) : { name: candidate.name || candidate.symbol || "?", detail: candidate.symbol && candidate.name ? candidate.symbol : "", ticker: "" };
  const priceCurrency = ticker ? instrumentCurrency(ticker, book, instrument) : undefined;
  return (
    <article className="candidateCard">
      <div className="candidateTopline">
        <div className="candidateIdentity">
          <span className="assetAvatar" aria-hidden="true">{(label.detail || label.name).slice(0, 2).toUpperCase()}</span>
          <div title={label.ticker || undefined}><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</div>
        </div>
        <div className={`scoreRing ${candidate.score >= 80 ? "high" : candidate.score >= 65 ? "medium" : "low"}`}><strong>{candidate.score}</strong><span>{t("score")}</span></div>
      </div>
      <div className="candidateBadges">
        <span className={`actionBadge ${actionClass}`}>{t(actionKey)}</span>
        <span>{t("risk")} · {t(riskKey)}</span>
        {candidate.referencePrice && <span>{t("reference")} · {priceCurrency ? money(candidate.referencePrice, priceCurrency, locale) : candidate.referencePrice}</span>}
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
        <div className="candidateHolding"><span>{t("holding")}</span><strong>{qty(candidate.heldQuantity, locale)}</strong><span>· {t("availableToSell")}</span><strong>{qty(candidate.availableToSell, locale)}</strong></div>
      )}
      {candidate.action === "watch" ? (
        <span className="watchChip">{t("watchOnly")}</span>
      ) : (
        <button
          className={`tradeButton ${actionClass}`}
          type="button"
          disabled={!writeEnabled || !instrument}
          onClick={() => onTrade(candidate)}
        >
          <span>{candidate.action === "sell" ? t("prepareSell") : t("prepareBuy")}</span>
          <Icon name="arrow" />
        </button>
      )}
    </article>
  );
}
