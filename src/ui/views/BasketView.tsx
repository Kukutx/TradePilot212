import { useState } from "react";
import { BASKET_ORDER_NOTE } from "../../shared/automation";
import type {
  BasketDraftPayload,
  BasketExecutionResult,
  BasketLeg,
  BasketPreview,
  BasketPurpose,
  RebalancePlan,
  RebalanceTrade,
} from "../../shared/automation";
import type { ExecutionVerificationResult, OrderDraft, OrderNotice } from "../../shared/contracts";
import type { MessageKey, SupportedLocale } from "../i18n";
import { DetailRow, Icon } from "../components/common";
import { dateTime, money, num, pct, time } from "../lib/format";
import { formatProblem, noticeText, rebalanceNoteText, rebalanceSkipText, verificationText, type Translator } from "../lib/messages";
import { LiveAcknowledgement, PolicyList } from "./OrderViews";

export type BasketDraftView = BasketDraftPayload & { rebalance?: RebalancePlan };

const PURPOSE_KEY: Record<BasketPurpose, MessageKey> = {
  rebalance: "basketPurposeRebalance",
  protective: "basketPurposeProtective",
  dca: "basketPurposeDca",
  custom: "basketPurposeCustom",
};

function sideLabel(draft: OrderDraft, t: Translator): string {
  return draft.side === "buy" ? t("buy") : t("sell");
}

function typeLabel(draft: OrderDraft, t: Translator): string {
  return draft.type === "market" ? t("market") : draft.type === "limit" ? t("limit") : draft.type === "stop" ? t("stop") : t("stopLimit");
}

function legName(leg: BasketLeg): string {
  return leg.instrument?.name || leg.instrument?.shortName || leg.draft.ticker;
}

function legSymbol(leg: BasketLeg): string {
  return leg.instrument?.shortName || leg.draft.ticker;
}

function LegHeading({ leg, t, locale }: { leg: BasketLeg; t: Translator; locale: SupportedLocale }) {
  const draft = leg.draft;
  return (
    <div className="basketLegHeading">
      <span className="assetAvatar" aria-hidden="true">{legSymbol(leg).slice(0, 2).toUpperCase()}</span>
      <div>
        <strong>{legName(leg)}</strong>
        {legName(leg) !== draft.ticker && <small>{legSymbol(leg) !== draft.ticker ? `${legSymbol(leg)} · ${draft.ticker}` : draft.ticker}</small>}
      </div>
      <span className={`sideBadge ${draft.side}`}>{sideLabel(draft, t)} · {num(draft.quantity, locale)}</span>
    </div>
  );
}

function LegFacts({ leg, trade, currency, t, locale }: { leg: BasketLeg; trade?: RebalanceTrade; currency?: string; t: Translator; locale: SupportedLocale }) {
  const draft = leg.draft;
  const priceCurrency = leg.instrument?.currencyCode ?? trade?.currency;
  const price = (value: number) => (priceCurrency ? money(value, priceCurrency, locale) : num(value, locale));
  return (
    <dl className="basketFacts">
      <div><dt>{t("type")}</dt><dd>{typeLabel(draft, t)}{draft.type !== "market" && draft.timeValidity ? ` · ${draft.timeValidity === "GOOD_TILL_CANCEL" ? t("gtc") : t("day")}` : ""}</dd></div>
      {draft.limitPrice !== undefined && <div><dt>{t("limitPrice")}</dt><dd>{price(draft.limitPrice)}</dd></div>}
      {draft.stopPrice !== undefined && <div><dt>{t("stopPrice")}</dt><dd>{price(draft.stopPrice)}</dd></div>}
      {draft.referencePrice !== undefined && <div><dt>{t("referencePrice")}</dt><dd>{price(draft.referencePrice)}</dd></div>}
      {leg.estimatedNotional !== undefined ? (
        <div>
          <dt>{t("estimatedAmount")}</dt>
          <dd>
            {money(leg.estimatedNotional, leg.estimatedNotionalCurrency ?? priceCurrency ?? currency ?? "EUR", locale)}
            {leg.estimatedAccountNotional !== undefined && currency && <span className="mutedInline"> ≈ {money(leg.estimatedAccountNotional, currency, locale)}</span>}
          </dd>
        </div>
      ) : trade && currency ? (
        <div><dt>{t("estimatedAmount")}</dt><dd>{money(trade.value, currency, locale)}</dd></div>
      ) : null}
      {trade && (
        <div>
          <dt>{t("weightCurrentToResulting")}</dt>
          <dd>{pct(trade.currentWeight, locale)} → {pct(trade.resultingWeight, locale)} <span className="mutedInline">({t("targetWeight")} {pct(trade.targetWeight, locale)})</span></dd>
        </div>
      )}
      {leg.reason && !trade && <div className="wide"><dt>{t("reason")}</dt><dd>{leg.reason}</dd></div>}
    </dl>
  );
}

function BasketHeader({
  environment,
  purpose,
  title,
  count,
  t,
  onClose,
}: {
  environment: BasketDraftView["environment"];
  purpose: BasketPurpose;
  title: string;
  count: number;
  t: Translator;
  onClose?: () => void;
}) {
  return (
    <div className="transactionHeader">
      <div>
        <span className={`environmentTag ${environment}`}>{environment.toUpperCase()}</span>
        <span className="purposeTag">{t(PURPOSE_KEY[purpose] ?? "basketPurposeCustom")}</span>
        <h2>{title || t("basketDraft")}</h2>
        <p>{count} {t("basketOrders")}</p>
      </div>
      {onClose && <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>}
    </div>
  );
}

function Notes({ notes, plan, t, locale }: { notes: string[]; plan?: RebalancePlan; t: Translator; locale: SupportedLocale }) {
  if (!notes.length) return null;
  const details = new Map((plan?.noteDetails ?? []).map((note) => [note.message, note]));
  const text = (note: string) => {
    const known = details.get(note);
    return known ? rebalanceNoteText(known, t, locale) : note;
  };
  return (
    <div className="basketNotes">
      <span className="policyTitle">{t("basketNotes")}</span>
      <ul>{notes.map((note, index) => <li key={`${index}-${note}`}>{text(note)}</li>)}</ul>
    </div>
  );
}

/**
 * Skipped instruments are listed in the rebalance summary, so their copies in the notes are dropped,
 * as is the server's sending-order note, which the widget shows in its own language.
 */
function withoutSkipped(all: string[], plan?: RebalancePlan): string[] {
  const notes = all.filter((note) => note !== BASKET_ORDER_NOTE);
  if (!plan?.skipped.length) return notes;
  const skipped = new Set(plan.skipped.map((item) => `${item.ticker}: ${item.reason}`));
  return notes.filter((note) => !skipped.has(note) && !note.startsWith(`Skipped ${plan.skipped.length} instrument(s)`));
}

function RebalanceSummary({ plan, t, locale }: { plan: RebalancePlan; t: Translator; locale: SupportedLocale }) {
  return (
    <section className="rebalanceSummary" aria-label={t("rebalanceSummary")}>
      <span className="policyTitle">{t("rebalanceSummary")}</span>
      <div className="confirmationRows">
        <DetailRow label={t("totalValue")} value={money(plan.totalValue, plan.accountCurrency, locale)} />
        <DetailRow label={t("cashBefore")} value={money(plan.cashBefore, plan.accountCurrency, locale)} />
        <DetailRow label={t("cashAfter")} value={money(plan.cashAfter, plan.accountCurrency, locale)} />
      </div>
      {plan.skipped.length > 0 && (
        <div className="basketNotes">
          <span className="policyTitle">{t("skippedTickers")}</span>
          <ul>{plan.skipped.map((item, index) => <li key={`${item.ticker}-${index}`}><strong>{item.ticker}</strong> · {rebalanceSkipText(item, t)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

export function BasketView({
  payload,
  legs,
  preview,
  result,
  verifications,
  canReview,
  busy,
  locale,
  t,
  onRemoveLeg,
  onReview,
  onBack,
  onConfirm,
  onClose,
  onVerify,
}: {
  payload: BasketDraftView;
  legs: BasketLeg[];
  preview: BasketPreview | null;
  result: BasketExecutionResult | null;
  verifications: Record<string, ExecutionVerificationResult>;
  canReview: boolean;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onRemoveLeg: (index: number) => void;
  onReview: () => void;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
  onClose: () => void;
  onVerify: (verificationId: string) => void;
}) {
  if (result) return <BasketResultView result={result} title={payload.title} verifications={verifications} busy={busy} locale={locale} t={t} onClose={onClose} onVerify={onVerify} />;
  if (preview) return <BasketConfirmation preview={preview} rebalance={payload.rebalance} busy={busy} locale={locale} t={t} onBack={onBack} onConfirm={onConfirm} />;

  const tradeFor = (leg: BasketLeg) => payload.rebalance?.trades.find((trade) => trade.ticker === leg.draft.ticker && trade.side === leg.draft.side);
  const live = payload.environment === "live";
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-label={t("basketDraft")}>
        <BasketHeader environment={payload.environment} purpose={payload.purpose} title={payload.title} count={legs.length} t={t} onClose={onClose} />
        {payload.rebalance && <RebalanceSummary plan={payload.rebalance} t={t} locale={locale} />}
        {legs.length === 0 ? <div className="emptyState compact">{t("basketEmpty")}</div> : (
          <ol className="basketLegList">
            {legs.map((leg, index) => (
              <li className="basketLeg" key={`${leg.draft.ticker}-${leg.draft.side}-${index}`}>
                <div className="basketLegTop">
                  <LegHeading leg={leg} t={t} locale={locale} />
                  <button className="removeLegButton" type="button" disabled={busy} onClick={() => onRemoveLeg(index)} aria-label={`${t("removeLeg")} · ${leg.draft.ticker}`} title={t("removeLeg")}>
                    <Icon name="close" />
                  </button>
                </div>
                <LegFacts leg={leg} trade={tradeFor(leg)} currency={payload.rebalance?.accountCurrency} t={t} locale={locale} />
              </li>
            ))}
          </ol>
        )}
        <Notes notes={withoutSkipped(payload.notes, payload.rebalance)} plan={payload.rebalance} t={t} locale={locale} />
        <p className="basketHint">{legs.length > 1 ? `${t("basketRemoveHint")} ${t("basketOrderNote")}` : t("basketRemoveHint")}</p>
        {!canReview && <div className="notice warning compactNotice">{t("basketReadonlyHint")}</div>}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onClose}>{t("cancel")}</button>
          <button className="primaryButton" type="button" disabled={busy || !canReview || legs.length === 0} onClick={onReview}>{busy ? t("checking") : t("reviewBasket")}</button>
        </div>
      </section>
    </main>
  );
}

function BasketConfirmation({
  preview,
  rebalance,
  busy,
  locale,
  t,
  onBack,
  onConfirm,
}: {
  preview: BasketPreview;
  rebalance?: RebalancePlan;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const live = preview.environment === "live";
  const [acknowledged, setAcknowledged] = useState(false);
  // A LIVE_FUNDS notice applies to the whole basket; show it once instead of on every leg.
  const liveFunds = preview.legs.flatMap((leg) => leg.notices).find((notice) => notice.code === "LIVE_FUNDS");
  const legNotices = (notices: OrderNotice[]) => notices.filter((notice) => notice.code !== "LIVE_FUNDS");
  const blocked = preview.legs.some((leg) => leg.policy.some((check) => check.status === "block"));
  const tradeFor = (leg: BasketLeg) => rebalance?.trades.find((trade) => trade.ticker === leg.draft.ticker && trade.side === leg.draft.side);
  return (
    <main className="transactionStage">
      <section className={`transactionPanel confirmationPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-label={t("finalConfirmation")}>
        <div className="confirmationHero">
          <span className={`environmentTag ${preview.environment}`}>{preview.environment.toUpperCase()}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")} · {t(PURPOSE_KEY[preview.purpose] ?? "basketPurposeCustom")}</span>
          <h2>{live ? t("realBasket") : t("demoBasket")}</h2>
          <strong className="confirmationAmount basketCount">{preview.legs.length} {t("basketOrders")}</strong>
          <span className="basketSubtitle">{preview.title}</span>
        </div>
        {liveFunds && <div className="notice warning compactNotice basketLiveNotice">{noticeText(liveFunds, t, locale)}</div>}
        <ol className="basketLegList">
          {preview.legs.map((leg, index) => (
            <li className="basketLeg" key={`${leg.draft.ticker}-${leg.draft.side}-${index}`}>
              <LegHeading leg={leg} t={t} locale={locale} />
              <LegFacts leg={leg} trade={tradeFor(leg)} currency={rebalance?.accountCurrency ?? preview.accountCurrency} t={t} locale={locale} />
              {legNotices(leg.notices).map((notice) => <div className="notice warning compactNotice" key={notice.code}>{noticeText(notice, t, locale)}</div>)}
              <PolicyList checks={leg.policy} t={t} locale={locale} />
            </li>
          ))}
        </ol>
        <Notes notes={withoutSkipped(preview.notes, rebalance)} plan={rebalance} t={t} locale={locale} />
        {preview.legs.length > 1 && <p className="basketHint">{t("basketOrderNote")}</p>}
        <div className="expiryLine">{t("snapshotAsOf")} · {dateTime(preview.snapshotAt, locale)} · {t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onBack}>{t("backToEdit")}</button>
          <button className={live ? "dangerButton" : "primaryButton"} type="button" disabled={busy || blocked || (live && !acknowledged)} onClick={() => onConfirm(live && acknowledged)}>
            {busy ? t("submitting") : live ? t("confirmLiveBasket") : t("confirmDemoBasket")}
          </button>
        </div>
      </section>
    </main>
  );
}

const RESULT_GLYPH = { submitted: "✓", rejected: "✕", unknown: "?", skipped: "–" } as const;

function BasketResultView({
  result,
  title,
  verifications,
  busy,
  locale,
  t,
  onClose,
  onVerify,
}: {
  result: BasketExecutionResult;
  title: string;
  verifications: Record<string, ExecutionVerificationResult>;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onClose: () => void;
  onVerify: (verificationId: string) => void;
}) {
  const statusKey: MessageKey =
    result.status === "submitted" ? "basketStatusSubmitted" : result.status === "partial" ? "basketStatusPartial" : result.status === "stopped" ? "basketStatusStopped" : "basketStatusRejected";
  const tone = result.status === "submitted" ? "success" : result.status === "rejected" ? "error" : "warning";
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${result.environment === "live" ? "liveTransaction" : ""}`} aria-label={t("basketResult")}>
        <BasketHeader environment={result.environment} purpose={result.purpose} title={title} count={result.legs.length} t={t} onClose={onClose} />
        <div className={`notice ${tone}`} role="status" aria-live="polite">
          <div className="noticeCopy"><strong>{t(statusKey)}</strong><span>{result.message}</span></div>
        </div>
        <ol className="basketLegList">
          {result.legs.map((leg, index) => {
            const outcome = leg.result ? leg.result.status : "skipped";
            const label = outcome === "submitted" ? t("submitted") : outcome === "rejected" ? t("notSubmitted") : outcome === "unknown" ? t("unknownStatus") : t("legSkipped");
            const verificationId = leg.result?.verificationId;
            const verification = verificationId ? verifications[verificationId] : undefined;
            return (
              <li className={`basketLeg resultLeg ${outcome}`} key={`${leg.draft.ticker}-${index}`}>
                <div className="basketLegTop">
                  <div className="basketLegHeading">
                    <span className="assetAvatar">{leg.draft.ticker.slice(0, 2).toUpperCase()}</span>
                    <div><strong>{leg.draft.ticker}</strong><small>{sideLabel(leg.draft, t)} · {typeLabel(leg.draft, t)} · {num(leg.draft.quantity, locale)}</small></div>
                  </div>
                  <span className={`resultBadge ${outcome}`}><span aria-hidden="true">{RESULT_GLYPH[outcome]}</span> {label}</span>
                </div>
                {leg.result && <p className="resultMessage">{leg.result.error ? formatProblem(leg.result.error, t, locale) : leg.result.message}</p>}
                {!leg.result && leg.skipped && <p className="resultMessage">{leg.skipped}</p>}
                {verificationId && (
                  <div className="verificationLine">
                    <span>{t("verificationIdLabel")} · <code>{verificationId}</code></span>
                    {outcome === "unknown" && (
                      <button className="secondaryButton" type="button" disabled={busy} onClick={() => onVerify(verificationId)}>
                        {busy ? t("verifying") : t("verifyExecution")}
                      </button>
                    )}
                  </div>
                )}
                {verification && <p className="resultMessage verificationResult">{verificationText(verification, t)}</p>}
              </li>
            );
          })}
        </ol>
        {!result.ok && <p className="basketHint">{t("basketNoRetry")}</p>}
        <div className="transactionFooter">
          <button className="primaryButton" type="button" onClick={onClose}>{t("done")}</button>
        </div>
      </section>
    </main>
  );
}
