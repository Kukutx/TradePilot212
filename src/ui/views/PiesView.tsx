import { useState } from "react";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PieOverview, PiesPayload } from "../../shared/pies";
import type { MessageKey, SupportedLocale } from "../i18n";
import { DetailRow, Icon, InstrumentName, Metric, useDialog } from "../components/common";
import { amount, pct, qty, signedClass, time } from "../lib/format";
import type { InstrumentBook } from "../lib/instruments";
import { envLabel, pieIssueText, pieNoticeText, pieResultText, type Translator } from "../lib/messages";
import { LiveAcknowledgement } from "./OrderViews";

const STATUS_KEY: Record<string, MessageKey> = { AHEAD: "pieAhead", ON_TRACK: "pieOnTrack", BEHIND: "pieBehind" };
const ACTION_KEY: Record<PieChangePreview["action"], MessageKey> = {
  create: "pieActionCreate",
  update: "pieActionUpdate",
  delete: "pieActionDelete",
  duplicate: "pieActionDuplicate",
};

type Slice = NonNullable<PieOverview["instruments"]>[number];

function SliceIssues({ slice, t }: { slice: Slice; t: Translator }) {
  if (!slice.issues.length) return null;
  return (
    <span className="pieIssue">
      <Icon name="alert" />
      {slice.issues.map((issue) => pieIssueText(issue, t)).join(" · ")}
    </span>
  );
}

function PieCard({ pie, currency, book, locale, t }: { pie: PieOverview; currency?: string; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const sum = (value: number | undefined, signed = false) => amount(value, currency, locale, { signed });
  return (
    <article className="pieCard">
      <header className="pieCardHeader">
        <div>
          <strong>{pie.name}</strong>
          <small>#{pie.id}{pie.status ? ` · ${t(STATUS_KEY[pie.status] ?? "pieOnTrack")}` : ""}</small>
        </div>
        <span className={`pieReturn ${signedClass(pie.result)}`}>
          {sum(pie.result, true)}
          {pie.resultPercent !== null && <small>{pct(pie.resultPercent / 100, locale, 2, { signed: true })}</small>}
        </span>
      </header>
      <dl className="basketFacts">
        <div><dt>{t("pieValue")}</dt><dd>{sum(pie.value)}</dd></div>
        <div><dt>{t("pieInvested")}</dt><dd>{sum(pie.invested)}</dd></div>
        <div><dt>{t("pieCash")}</dt><dd>{sum(pie.cash)}</dd></div>
        <div><dt>{t("pieDividends")}</dt><dd>{sum(pie.dividends.gained)}</dd></div>
        {pie.goal !== undefined && <div><dt>{t("pieGoal")}</dt><dd>{sum(pie.goal)}{pie.progress === null ? "" : ` · ${pct(pie.progress, locale)}`}</dd></div>}
        {pie.drift !== undefined && <div><dt>{t("pieDrift")}</dt><dd>{pct(pie.drift, locale)}</dd></div>}
      </dl>
      {pie.instruments && pie.instruments.length > 0 && (
        <>
          <div className="pieTableWrap">
            <table className="positionsTable pieSlices">
              <thead><tr><th>{t("symbol")}</th><th>{t("pieTarget")}</th><th>{t("pieCurrent")}</th><th>{t("pieDrift")}</th><th>{t("quantity")}</th></tr></thead>
              <tbody>
                {pie.instruments.map((slice) => (
                  <tr key={slice.ticker}>
                    <td><InstrumentName ticker={slice.ticker} book={book} /><SliceIssues slice={slice} t={t} /></td>
                    <td>{pct(slice.targetShare, locale)}</td>
                    <td>{pct(slice.currentShare, locale)}</td>
                    <td>{pct(slice.driftShare, locale, 1, { signed: true })}</td>
                    <td>{qty(slice.ownedQuantity, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="sliceList">
            {pie.instruments.map((slice) => (
              <li key={slice.ticker}>
                <div className="sliceTop"><InstrumentName ticker={slice.ticker} book={book} /><span className="sliceQuantity">{qty(slice.ownedQuantity, locale)}<small>{t("quantity")}</small></span></div>
                <SliceIssues slice={slice} t={t} />
                <dl className="sliceFacts">
                  <div><dt>{t("pieTarget")}</dt><dd>{pct(slice.targetShare, locale)}</dd></div>
                  <div><dt>{t("pieCurrent")}</dt><dd>{pct(slice.currentShare, locale)}</dd></div>
                  <div><dt>{t("pieDrift")}</dt><dd>{pct(slice.driftShare, locale, 1, { signed: true })}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

export function PiesView({ payload, book, locale, t }: { payload: PiesPayload; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  // A single pie (get_pie) carries its currency on the pie; a list carries it on the payload.
  const currency = payload.currency ?? payload.pies.find((pie) => pie.currency)?.currency;
  const sum = (value: number, signed = false) => amount(value, currency, locale, { signed });
  return (
    <main className="contentStack">
      <section className="dataPanel" aria-labelledby="pies-title">
        <div className="pieHeader">
          <h2 id="pies-title">{t("piesTitle")}</h2>
          <span className="mutedInline">{t("piesDeprecated")}</span>
        </div>
        <div className="metricGrid pieTotals">
          <Metric label={t("pieValue")} value={sum(payload.totals.value)} />
          <Metric label={t("pieInvested")} value={sum(payload.totals.invested)} />
          <Metric label={t("pieResult")} value={sum(payload.totals.result, true)} tone={signedClass(payload.totals.result)} />
          <Metric label={t("pieCash")} value={sum(payload.totals.cash)} />
        </div>
        {payload.pies.length === 0
          ? <div className="emptyState compact">{t("noPies")}</div>
          : payload.pies.map((pie) => <PieCard key={pie.id} pie={pie} currency={pie.currency ?? currency} book={book} locale={locale} t={t} />)}
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

function PieChangeResultPanel({ payload, result, title, t, onClose }: { payload: PieChangeDraftPayload; result: PieChangeResult; title: string; t: Translator; onClose: () => void }) {
  const live = payload.draft.environment === "live";
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-labelledby="pie-result-title">
        <div className="transactionHeader">
          <div>
            <span className={`environmentTag ${payload.draft.environment}`}>{envLabel(payload.draft.environment, t)}</span>
            <span className="purposeTag">{t("piesTitle")}</span>
            <h2 id="pie-result-title">{title}</h2>
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        <div className={`notice ${result.ok ? "success" : result.status === "unknown" ? "warning" : "error"}`} role="status" aria-live="polite">
          <div className="noticeCopy"><strong>{result.ok ? t("submitted") : result.status === "unknown" ? t("unknownStatus") : t("notSubmitted")}</strong><span>{pieResultText(result, t)}</span></div>
        </div>
        <div className="transactionFooter"><button className="primaryButton" type="button" onClick={onClose}>{t("done")}</button></div>
      </section>
    </main>
  );
}

function PieChangeConfirmation({ payload, preview, title, book, busy, locale, t, onBack, onConfirm }: {
  payload: PieChangeDraftPayload;
  preview: PieChangePreview;
  title: string;
  book?: InstrumentBook;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useDialog();
  const draft = payload.draft;
  const live = draft.environment === "live";
  const currency = preview.current?.currency ?? payload.current?.currency;
  return (
    <main className="transactionStage">
      <section ref={dialog.panel} className={`transactionPanel basketPanel confirmationPanel ${live ? "liveTransaction" : ""}`} {...dialog.props}>
        <div className="transactionHeader">
          <div>
            <span className={`environmentTag ${draft.environment}`}>{envLabel(draft.environment, t)}</span>
            <span className="purposeTag">{t("finalConfirmation")}</span>
            <h2 id={dialog.headingId} ref={dialog.heading} tabIndex={-1}>{title}</h2>
          </div>
        </div>
        {preview.changes.length > 0 && (
          <table className="positionsTable pieSlices compactSlices">
            <thead><tr><th>{t("symbol")}</th><th>{t("pieBefore")}</th><th>{t("pieAfter")}</th></tr></thead>
            <tbody>{preview.changes.map((change) => <tr key={change.ticker}><td><InstrumentName ticker={change.ticker} book={book} /></td><td>{pct(change.from, locale)}</td><td>{pct(change.to, locale)}</td></tr>)}</tbody>
          </table>
        )}
        {preview.request && (
          <div className="confirmationRows">
            <DetailRow label={t("pieName")} value={preview.request.name} />
            <DetailRow label={t("pieDividendAction")} value={preview.request.dividendCashAction === "REINVEST" ? t("pieReinvest") : t("pieToCash")} />
            {preview.request.goal !== undefined && <DetailRow label={t("pieGoal")} value={amount(preview.request.goal, currency, locale)} />}
          </div>
        )}
        {preview.notices.map((notice) => <div className="notice warning compactNotice" key={notice}>{pieNoticeText(notice, preview, t, locale, book)}</div>)}
        <div className="expiryLine">{t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onBack}>{t("backToEdit")}</button>
          <button className={live || draft.action === "delete" ? "dangerButton" : "primaryButton"} type="button" disabled={busy || (live && !acknowledged)} onClick={() => onConfirm(live && acknowledged)}>{busy ? t("submitting") : t("confirmPieChange")}</button>
        </div>
      </section>
    </main>
  );
}

export function PieChangeView({
  payload,
  preview,
  result,
  canReview,
  busy,
  book,
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
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onReview: () => void;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
  onClose: () => void;
}) {
  const draft = payload.draft;
  const live = draft.environment === "live";
  const title = `${t(ACTION_KEY[draft.action])} · ${draft.name ?? payload.current?.name ?? (draft.pieId ? `#${draft.pieId}` : "")}`;

  if (result) return <PieChangeResultPanel payload={payload} result={result} title={title} t={t} onClose={onClose} />;
  if (preview) return <PieChangeConfirmation payload={payload} preview={preview} title={title} book={book} busy={busy} locale={locale} t={t} onBack={onBack} onConfirm={onConfirm} />;

  const shares = draft.instrumentShares;
  const current = new Map((payload.current?.instruments ?? []).map((slice) => [slice.ticker, slice.targetShare]));
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-labelledby="pie-change-title">
        <div className="transactionHeader">
          <div>
            <span className={`environmentTag ${draft.environment}`}>{envLabel(draft.environment, t)}</span>
            <span className="purposeTag">{t("piesTitle")}</span>
            <h2 id="pie-change-title">{title}</h2>
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        {shares && (
          <table className="positionsTable pieSlices compactSlices">
            <thead><tr><th>{t("symbol")}</th>{current.size > 0 && <th>{t("pieCurrent")}</th>}<th>{t("pieTarget")}</th></tr></thead>
            <tbody>{normalisedShares(shares).map(([ticker, share]) => (
              <tr key={ticker}><td><InstrumentName ticker={ticker} book={book} /></td>{current.size > 0 && <td>{current.has(ticker) ? pct(current.get(ticker), locale) : "—"}</td>}<td>{pct(share, locale)}</td></tr>
            ))}</tbody>
          </table>
        )}
        {!canReview && <div className="notice warning compactNotice">{t("basketReadonlyHint")}</div>}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onClose}>{t("cancel")}</button>
          <button className="primaryButton" type="button" data-focus-id="review-pie" disabled={busy || !canReview} onClick={onReview}>{busy ? t("checking") : t("reviewPieChange")}</button>
        </div>
      </section>
    </main>
  );
}
