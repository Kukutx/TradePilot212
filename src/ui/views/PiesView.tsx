import { useState } from "react";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PieOverview, PiesPayload } from "../../shared/pies";
import type { MessageKey, SupportedLocale } from "../i18n";
import { DetailRow, Icon } from "../components/common";
import { money, num, pct, signedClass, time } from "../lib/format";
import type { Translator } from "../lib/messages";
import { LiveAcknowledgement } from "./OrderViews";

const amount = (value: number | undefined, locale: SupportedLocale, currency?: string) => (currency ? money(value, currency, locale) : num(value, locale, 2));

const STATUS_KEY: Record<string, MessageKey> = { AHEAD: "pieAhead", ON_TRACK: "pieOnTrack", BEHIND: "pieBehind" };
const ACTION_KEY: Record<PieChangePreview["action"], MessageKey> = {
  create: "pieActionCreate",
  update: "pieActionUpdate",
  delete: "pieActionDelete",
  duplicate: "pieActionDuplicate",
};

function PieCard({ pie, currency, locale, t }: { pie: PieOverview; currency?: string; locale: SupportedLocale; t: Translator }) {
  return (
    <article className="pieCard">
      <header className="pieCardHeader">
        <div>
          <strong>{pie.name}</strong>
          <small>#{pie.id}{pie.status ? ` · ${t(STATUS_KEY[pie.status] ?? "pieOnTrack")}` : ""}</small>
        </div>
        <span className={signedClass(pie.result)}>{amount(pie.result, locale, currency)}{pie.resultPercent === null ? "" : ` (${num(pie.resultPercent, locale, 2)}%)`}</span>
      </header>
      <dl className="basketFacts">
        <div><dt>{t("pieValue")}</dt><dd>{amount(pie.value, locale, currency)}</dd></div>
        <div><dt>{t("investedValue")}</dt><dd>{amount(pie.invested, locale, currency)}</dd></div>
        <div><dt>{t("pieCash")}</dt><dd>{amount(pie.cash, locale, currency)}</dd></div>
        <div><dt>{t("pieDividends")}</dt><dd>{amount(pie.dividends.gained, locale, currency)}</dd></div>
        {pie.goal !== undefined && <div><dt>{t("pieGoal")}</dt><dd>{amount(pie.goal, locale, currency)}{pie.progress === null ? "" : ` · ${pct(pie.progress, locale)}`}</dd></div>}
        {pie.drift !== undefined && <div><dt>{t("pieDrift")}</dt><dd>{pct(pie.drift, locale)}</dd></div>}
      </dl>
      {pie.instruments && pie.instruments.length > 0 && (
        <div className="pieTableWrap">
          <table className="positionsTable pieSlices">
            <thead><tr><th>{t("symbol")}</th><th>{t("pieTarget")}</th><th>{t("pieCurrent")}</th><th>{t("pieDrift")}</th><th>{t("quantity")}</th></tr></thead>
            <tbody>
              {pie.instruments.map((slice) => (
                <tr key={slice.ticker}>
                  <td>{slice.ticker}{slice.issues.length > 0 && <span className="pieIssue" title={slice.issues.map((issue) => `${issue.name} (${issue.severity})`).join(", ")}> !</span>}</td>
                  <td>{pct(slice.targetShare, locale)}</td>
                  <td>{pct(slice.currentShare, locale)}</td>
                  <td>{slice.driftShare > 0 ? "+" : ""}{pct(slice.driftShare, locale)}</td>
                  <td>{num(slice.ownedQuantity, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function PiesView({ payload, locale, t }: { payload: PiesPayload; locale: SupportedLocale; t: Translator }) {
  return (
    <main className="contentStack">
      <section className="dataPanel" aria-label={t("piesTitle")}>
        <div className="pieHeader">
          <h2>{t("piesTitle")}</h2>
          <span className="mutedInline">{t("piesDeprecated")}</span>
        </div>
        <div className="confirmationRows">
          <DetailRow label={t("pieValue")} value={amount(payload.totals.value, locale, payload.currency)} />
          <DetailRow label={t("investedValue")} value={amount(payload.totals.invested, locale, payload.currency)} />
          <DetailRow label={t("unrealizedPnL")} value={amount(payload.totals.result, locale, payload.currency)} />
          <DetailRow label={t("pieCash")} value={amount(payload.totals.cash, locale, payload.currency)} />
        </div>
        {payload.pies.length === 0 ? <div className="emptyState compact">{t("noPies")}</div> : payload.pies.map((pie) => <PieCard key={pie.id} pie={pie} {...(payload.currency ? { currency: payload.currency } : {})} locale={locale} t={t} />)}
        {payload.notes.length > 0 && <div className="basketNotes"><ul>{payload.notes.map((note) => <li key={note}>{note}</li>)}</ul></div>}
      </section>
    </main>
  );
}

/** Draft shares may be any positive numbers ({"VUSA": 70, "EIMI": 30}); the broker gets them normalised to 1. */
function normalisedShares(shares: Record<string, number>): Array<[string, number]> {
  const total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  return Object.entries(shares).map(([ticker, value]) => [ticker, total > 0 ? value / total : 0]);
}

export function PieChangeView({
  payload,
  preview,
  result,
  canReview,
  busy,
  locale,
  t,
  onReview,
  onBack,
  onConfirm,
  onClose,
}: {
  payload: PieChangeDraftPayload;
  preview: PieChangePreview | null;
  result: PieChangeResult | null;
  canReview: boolean;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onReview: () => void;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const draft = payload.draft;
  const live = draft.environment === "live";
  const title = `${t(ACTION_KEY[draft.action])} · ${draft.name ?? payload.current?.name ?? (draft.pieId ? `#${draft.pieId}` : "")}`;
  const header = (
    <div className="transactionHeader">
      <div>
        <span className={`environmentTag ${draft.environment}`}>{draft.environment.toUpperCase()}</span>
        <span className="purposeTag">{t("piesTitle")}</span>
        <h2>{title}</h2>
      </div>
      <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
    </div>
  );

  if (result) {
    return (
      <main className="transactionStage">
        <section className={`transactionPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-label={t("pieChangeResult")}>
          {header}
          <div className={`notice ${result.ok ? "success" : result.status === "unknown" ? "warning" : "error"}`} role="status" aria-live="polite">
            <div className="noticeCopy"><strong>{result.ok ? t("submitted") : result.status === "unknown" ? t("unknownStatus") : t("notSubmitted")}</strong><span>{result.message}</span></div>
          </div>
          <div className="transactionFooter"><button className="primaryButton" type="button" onClick={onClose}>{t("done")}</button></div>
        </section>
      </main>
    );
  }

  const shares = preview?.request?.instrumentShares ?? draft.instrumentShares;
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${preview ? "confirmationPanel" : ""} ${live ? "liveTransaction" : ""}`} aria-label={t("pieChange")}>
        {header}
        {preview && preview.changes.length > 0 ? (
          <div className="pieTableWrap">
            <table className="positionsTable pieSlices">
              <thead><tr><th>{t("symbol")}</th><th>{t("pieBefore")}</th><th>{t("pieAfter")}</th></tr></thead>
              <tbody>{preview.changes.map((change) => <tr key={change.ticker}><td>{change.ticker}</td><td>{pct(change.from, locale)}</td><td>{pct(change.to, locale)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : shares && (
          <div className="pieTableWrap">
            <table className="positionsTable pieSlices">
              <thead><tr><th>{t("symbol")}</th><th>{t("pieTarget")}</th></tr></thead>
              <tbody>{normalisedShares(shares).map(([ticker, share]) => <tr key={ticker}><td>{ticker}</td><td>{pct(share, locale)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {preview?.request && (
          <div className="confirmationRows">
            <DetailRow label={t("pieName")} value={preview.request.name} />
            <DetailRow label={t("pieDividendAction")} value={preview.request.dividendCashAction === "REINVEST" ? t("pieReinvest") : t("pieToCash")} />
            {preview.request.goal !== undefined && <DetailRow label={t("pieGoal")} value={amount(preview.request.goal, locale)} />}
          </div>
        )}
        {preview?.notices.map((notice) => <div className="notice warning compactNotice" key={notice}>{notice}</div>)}
        {preview && <div className="expiryLine">{t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>}
        {!canReview && <div className="notice warning compactNotice">{t("basketReadonlyHint")}</div>}
        {preview && live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter">
          {preview
            ? <button className="secondaryButton" type="button" onClick={onBack}>{t("backToEdit")}</button>
            : <button className="secondaryButton" type="button" onClick={onClose}>{t("cancel")}</button>}
          {preview
            ? <button className={live || draft.action === "delete" ? "dangerButton" : "primaryButton"} type="button" disabled={busy || (live && !acknowledged)} onClick={() => onConfirm(live && acknowledged)}>{busy ? t("submitting") : t("confirmPieChange")}</button>
            : <button className="primaryButton" type="button" disabled={busy || !canReview} onClick={onReview}>{busy ? t("checking") : t("reviewPieChange")}</button>}
        </div>
      </section>
    </main>
  );
}
