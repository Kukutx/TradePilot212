import { useEffect, useState, type ReactNode } from "react";
import type { PolicyCheck } from "../../shared/automation";
import type { CancelPreview, Instrument, OrderDraft, OrderPreview, OrderResolution, PendingOrder, Position } from "../../shared/contracts";
import { MAX_JOURNAL_TEXT } from "../../shared/journal";
import type { SupportedLocale } from "../i18n";
import { DetailRow, Field, Icon, InstrumentName, useDialog } from "../components/common";
import { amount, dateTime, money, notional, parseAmount, qty, time } from "../lib/format";
import { instrumentCurrency, type InstrumentBook } from "../lib/instruments";
import { countText, envLabel, fill, noticeText, orderTypeLabel, policyMessage, policyRuleLabel, policyStatusLabel, sizingText, validityLabel, type Translator } from "../lib/messages";
import { riskAtStop, summarizeOrder } from "../lib/orders";
import { radioKeys, radioTab } from "../lib/radio";
import { readAsHint } from "../components/alerts";

const POLICY_GLYPH: Record<PolicyCheck["status"], string> = { pass: "✓", warn: "!", skip: "–", block: "✕" };

/** Policy results with an icon and a status word, so the outcome never depends on color alone. */
export function PolicyList({ checks, t, locale }: { checks?: PolicyCheck[]; t: Translator; locale: SupportedLocale }) {
  if (!checks?.length) return null;
  const order: PolicyCheck["status"][] = ["block", "warn", "skip"];
  const flagged = checks.filter((check) => check.status !== "pass").sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const passed = checks.filter((check) => check.status === "pass");
  const row = (check: PolicyCheck, index: number) => (
    <li className={`policyCheck ${check.status}`} key={`${check.rule}-${index}`}>
      <span className="policyGlyph" aria-hidden="true">{POLICY_GLYPH[check.status] ?? "?"}</span>
      <span className="policyCopy">
        <strong>{policyStatusLabel(check.status, t)} · {policyRuleLabel(check.rule, t)}</strong>
        {check.message && <span>{policyMessage(check, t, locale)}</span>}
      </span>
    </li>
  );
  return (
    <div className="policyBlock" aria-label={t("policyChecks")}>
      <span className="policyTitle">{t("policyChecks")}</span>
      {flagged.length > 0 && <ul className="policyList">{flagged.map(row)}</ul>}
      {passed.length > 0 && (
        <details className="policyPassed">
          <summary><span className="policyGlyph" aria-hidden="true">✓</span>{countText("checksPassed", passed.length, t, locale)}</summary>
          <ul className="policyList">{passed.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

/** The editable text of a number input; an empty or partial entry stays as typed instead of turning into 0. */
/** What was typed stays as typed ("1,5", "1 234") while it reads as the value; only a value set from elsewhere replaces it. */
export const syncedText = (current: string, value: number | undefined) =>
  current.trim() !== "" && parseAmount(current) === value ? current : value === undefined ? "" : String(value);

function useNumberText(value: number | undefined): [string, (text: string) => void] {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    setText((current) => syncedText(current, value));
  }, [value]);
  return [text, setText];
}

/** A typed amount above zero, with either a point or a comma for the decimals ("1,5" or "1.5"), as the other forms read it. */
const positive = (text: string) => { const value = parseAmount(text); return Number.isFinite(value) && value > 0; };

/**
 * A form field's few choices as one row of buttons (a radio group named by the field's label), rather than a select
 * that hides them: the side and the order type. `id` is the field's, so the group can take the label's name.
 */
function Choices<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="segmented formChoices" role="radiogroup" aria-labelledby={`${id}-label`} id={id} onKeyDown={radioKeys}>
      {options.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} tabIndex={radioTab(value === key)} className={`${value === key ? "active" : ""} choice-${key}`} onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}

export function OrderEditor({
  draft,
  originalDraft,
  resolution,
  resolvedInstrument,
  book,
  locale,
  t,
  busy,
  onChange,
  onClose,
  onReview,
}: {
  draft: OrderDraft;
  originalDraft?: OrderDraft;
  resolution?: OrderResolution;
  resolvedInstrument?: Instrument;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onChange: (draft: OrderDraft) => void;
  onClose: () => void;
  onReview: () => void;
}) {
  const set = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) => onChange({ ...draft, [key]: value });
  const [quantityText, setQuantityText] = useNumberText(draft.quantity);
  const [limitText, setLimitText] = useNumberText(draft.limitPrice);
  const [stopText, setStopText] = useNumberText(draft.stopPrice);
  const [referenceText, setReferenceText] = useNumberText(draft.referencePrice);
  const [touched, setTouched] = useState(false);
  const needsLimit = draft.type === "limit" || draft.type === "stop_limit";
  const needsStop = draft.type === "stop" || draft.type === "stop_limit";
  const quantityError = positive(quantityText) ? undefined : t("quantityRequired");
  const limitError = needsLimit && !positive(limitText) ? t("priceRequired") : undefined;
  const stopError = needsStop && !positive(stopText) ? t("priceRequired") : undefined;
  const invalid = Boolean(quantityError || limitError || stopError);
  const show = (error: string | undefined, text: string) => (touched || text !== "" ? error : undefined);
  const currency = instrumentCurrency(draft.ticker, book, resolvedInstrument);
  const quantityEdited = resolution ? Math.abs(draft.quantity - resolution.resolvedQuantity) > 1e-8 : false;
  const risk = riskAtStop(draft, resolution);
  const orderEdited = originalDraft ? (["side", "type", "quantity", "extendedHours", "timeValidity", "limitPrice", "stopPrice", "referencePrice"] as const).some((key) => originalDraft[key] !== draft[key]) : quantityEdited;

  // An amount typed other than as a plain number ("1,5", "1 234") says how it was read, as the alert form does.
  const hintFor = (text: string, display: (value: number) => string) => {
    const hint = String(parseAmount(text)) === text.trim() ? undefined : readAsHint(text, display, t);
    return hint ? { hint } : {};
  };
  const priceInput = (text: string, setText: (text: string) => void, key: "limitPrice" | "stopPrice" | "referencePrice") =>
    (props: { id: string }) => (
      <input {...props} inputMode="decimal" autoComplete="off" value={text} placeholder={key === "referencePrice" ? "—" : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const value = positive(next) ? parseAmount(next) : undefined;
          if (key === "referencePrice") onChange({ ...draft, referencePrice: value, referencePriceAt: undefined });
          else set(key, value);
        }} />
    );

  return (
    <main className="transactionStage">
      <section className={`transactionPanel ${draft.environment === "live" ? "liveTransaction" : ""}`} aria-labelledby="order-editor-title">
        <div className="transactionHeader">
          <div>
            <span className={`environmentTag ${draft.environment}`}>{envLabel(draft.environment, t)}</span>
            <h2 id="order-editor-title">{t("orderDraft")}</h2>
            <InstrumentName ticker={draft.ticker} book={book} instrument={resolvedInstrument} className="headerInstrument" />
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        {resolution && (
          <div className="resolutionCard">
            <div><span>{t("resolvedFromRequest")}</span><strong>{sizingText(resolution.sizing, resolvedInstrument, locale, t, resolution.accountCurrency)}</strong></div>
            <div><span>{t("calculatedQuantity")}</span><strong>{qty(resolution.resolvedQuantity, locale)}</strong></div>
            {risk && (
              <div className={`resolutionRisk ${risk.over ? "over" : ""}`} aria-live="polite">
                <strong>{risk.loss === undefined ? t("riskStopAbove") : fill(t(risk.over ? "riskLossOver" : "riskLoss"), { loss: amount(-risk.loss, resolution.accountCurrency, locale, { signed: true }), budget: amount(risk.budget, resolution.accountCurrency, locale) })}</strong>
                <small>{risk.cashCapped ? `${t("riskCashCapped")} · ` : ""}{t("riskStopSeparate")}</small>
              </div>
            )}
            {orderEdited && <div className="resolutionEdited"><span>{t("manualEdited")}</span><strong>{quantityEdited ? qty(draft.quantity, locale) : t("otherFieldsChanged")}</strong>{quantityEdited && <button type="button" onClick={() => { setQuantityText(String(resolution.resolvedQuantity)); set("quantity", resolution.resolvedQuantity); }}>{t("restoreCalculated")}</button>}</div>}
          </div>
        )}
        <form className="formGrid" noValidate onSubmit={(event) => { event.preventDefault(); setTouched(true); if (!invalid && !busy) onReview(); }}>
          <Field label={t("side")}>{(props) => <Choices id={props.id} value={draft.side} options={[["buy", t("buy")], ["sell", t("sell")]]} onChange={(side) => set("side", side)} />}</Field>
          <Field label={t("type")}>{(props) => <Choices id={props.id} value={draft.type} options={[["market", t("market")], ["limit", t("limit")], ["stop", t("stop")], ["stop_limit", t("stopLimit")]]} onChange={(type) => set("type", type)} />}</Field>
          <Field label={t("quantity")} error={show(quantityError, quantityText)} {...hintFor(quantityText, (value) => qty(value, locale))}>
            {(props) => <input {...props} inputMode="decimal" autoComplete="off" required value={quantityText}
              onChange={(event) => { setQuantityText(event.target.value); if (positive(event.target.value)) set("quantity", parseAmount(event.target.value)); }} />}
          </Field>
          {needsLimit && <Field label={t("limitPrice")} unit={currency} error={show(limitError, limitText)} {...hintFor(limitText, (value) => amount(value, currency, locale))}>{priceInput(limitText, setLimitText, "limitPrice")}</Field>}
          {needsStop && <Field label={t("stopPrice")} unit={currency} error={show(stopError, stopText)} {...hintFor(stopText, (value) => amount(value, currency, locale))}>{priceInput(stopText, setStopText, "stopPrice")}</Field>}
          <Field label={t("referencePrice")} unit={currency} hint={t("referencePriceHint")}>{priceInput(referenceText, setReferenceText, "referencePrice")}</Field>
          {draft.type !== "market" && <Field label={t("validity")}>{(props) => <Choices id={props.id} value={draft.timeValidity ?? "DAY"} options={[["DAY", t("day")], ["GOOD_TILL_CANCEL", t("gtc")]]} onChange={(validity) => set("timeValidity", validity)} />}</Field>}
          {draft.type === "market" && <label className="toggleField"><input type="checkbox" checked={draft.extendedHours ?? false} onChange={(event) => set("extendedHours", event.target.checked)} /><span className="toggleTrack"><span /></span><span>{t("extendedHours")}</span></label>}
          <div className="wideField">
            <Field label={t("orderThesis")} hint={t("orderThesisHint")}>
              {(props) => <textarea {...props} rows={2} maxLength={MAX_JOURNAL_TEXT} value={draft.thesis ?? ""}
                onChange={(event) => onChange({ ...draft, thesis: event.target.value || undefined })} />}
            </Field>
          </div>
        </form>
        <div className="transactionFooter">
          <button type="button" className="secondaryButton" onClick={onClose}>{t("cancel")}</button>
          <button type="button" className="primaryButton" data-focus-id="review-order" disabled={busy} aria-disabled={invalid || undefined}
            onClick={() => { setTouched(true); if (!invalid) onReview(); }}>{busy ? t("checking") : t("reviewOrder")}</button>
        </div>
      </section>
    </main>
  );
}

/** What a cancellation removes, e.g. "Sell 3 Tesla (TSLA) · Limit $215.00 · Order 81234". */
export function cancelDescription(preview: Pick<CancelPreview, "orderId" | "order">, t: Translator, locale: SupportedLocale, positions: Position[] = [], book?: InstrumentBook): string {
  const order: PendingOrder | undefined = preview.order;
  if (!order?.ticker) return `${t("order")} ${preview.orderId}`;
  const summary = summarizeOrder(order, t, locale, positions, book);
  const name = summary.detail ? `${summary.name} (${summary.detail})` : summary.name;
  return [`${summary.side === "sell" ? t("sell") : t("buy")} ${qty(summary.quantity ?? 0, locale)} ${name}`, summary.type, ...summary.prices, `${t("order")} ${preview.orderId}`]
    .filter(Boolean).join(" · ");
}

/** Second, explicit step for Live writes: the confirm button stays disabled until this is ticked. */
export function LiveAcknowledgement({ checked, onChange, t }: { checked: boolean; onChange: (value: boolean) => void; t: Translator }) {
  return (
    <label className="liveAck">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{t("liveAckLabel")}</span>
    </label>
  );
}

export function OrderConfirmation({
  preview,
  book,
  locale,
  t,
  busy,
  onBack,
  onConfirm,
}: {
  preview: OrderPreview;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const draft = preview.draft;
  const live = draft.environment === "live";
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useDialog();
  const amountCurrency = preview.estimatedNotionalCurrency || preview.instrument.currencyCode;
  const instrument = preview.instrument;
  return (
    <main className="transactionStage">
      <section ref={dialog.panel} className={`transactionPanel confirmationPanel ${live ? "liveTransaction" : ""}`} {...dialog.props}>
        <div className="confirmationHero">
          <span className={`environmentTag ${draft.environment}`}>{envLabel(draft.environment, t)}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")}</span>
          <h2 id={dialog.headingId} ref={dialog.heading} tabIndex={-1}>{live ? t("realOrder") : t("demoOrder")}</h2>
          <strong className="confirmationAmount">{notional(preview.estimatedNotional, amountCurrency, locale)}</strong>
          {preview.estimatedAccountNotional !== undefined && preview.accountCurrency && (
            <span className="confirmationConverted">≈ {money(preview.estimatedAccountNotional, preview.accountCurrency, locale)} · {t("inAccountCurrency")}</span>
          )}
        </div>
        <div className="confirmationRows">
          <div><span>{t("instrument")}</span><InstrumentName ticker={draft.ticker} book={book} instrument={instrument} /></div>
          <DetailRow label={t("side")} value={draft.side === "buy" ? t("buy") : t("sell")} tone={`orderSide ${draft.side}`} />
          <DetailRow label={t("type")} value={orderTypeLabel(draft.type, t)} />
          <DetailRow label={t("quantity")} value={qty(draft.quantity, locale)} />
          {draft.limitPrice !== undefined && <DetailRow label={t("limitPrice")} value={money(draft.limitPrice, instrument.currencyCode, locale)} />}
          {draft.stopPrice !== undefined && <DetailRow label={t("stopPrice")} value={money(draft.stopPrice, instrument.currencyCode, locale)} />}
          {draft.type !== "market" && <DetailRow label={t("validity")} value={validityLabel(draft.timeValidity, t)} />}
          {draft.referencePrice !== undefined && <DetailRow label={t("referencePrice")} value={money(draft.referencePrice, instrument.currencyCode, locale)} />}
          {draft.referencePriceAt && <DetailRow label={t("referenceAsOf")} value={dateTime(draft.referencePriceAt, locale)} />}
          {draft.fxRateAt && <DetailRow label={t("fxAsOf")} value={dateTime(draft.fxRateAt, locale)} />}
          <DetailRow label={t("snapshotAsOf")} value={dateTime(preview.snapshotAt, locale)} />
        </div>
        {draft.thesis && <div className="journalText confirmationThesis"><span>{t("journalWhy")}</span><p>{draft.thesis}</p></div>}
        {(preview.notices ?? []).map((notice) => <div className="notice warning compactNotice" key={notice.code}>{noticeText(notice, t, locale)}</div>)}
        <PolicyList checks={preview.policy} t={t} locale={locale} />
        <div className="expiryLine">{t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter"><button type="button" className="secondaryButton" onClick={onBack}>{t("backToEdit")}</button><button type="button" className={live ? "dangerButton" : "primaryButton"} disabled={busy || (live && !acknowledged) || (preview.policy ?? []).some((check) => check.status === "block")} onClick={() => onConfirm(live && acknowledged)}>{busy ? t("submitting") : live ? t("confirmLive") : t("confirmDemo")}</button></div>
      </section>
    </main>
  );
}

export function ConfirmModal({
  title,
  body,
  danger,
  confirmLabel,
  busy,
  t,
  acknowledgement,
  canConfirm = true,
  ready = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  danger: boolean;
  confirmLabel: string;
  busy: boolean;
  t: Translator;
  /** When set, a checkbox with this text must be ticked before confirming. */
  acknowledgement?: string;
  /** false leaves only the way back, e.g. when the order is no longer open. */
  canConfirm?: boolean;
  /** false while the confirmation is still being prepared. */
  ready?: boolean;
  onCancel: () => void;
  onConfirm: (acknowledged: boolean) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useDialog();
  return (
    <main className="transactionStage">
      <section ref={dialog.panel} className={`transactionPanel smallDialog ${danger ? "liveTransaction" : ""}`} {...dialog.props}>
        <h2 id={dialog.headingId} ref={dialog.heading} tabIndex={-1}>{title}</h2>
        <div className="dialogBody">{body}</div>
        {acknowledgement && canConfirm && (
          <label className="liveAck">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>{acknowledgement}</span>
          </label>
        )}
        <div className="transactionFooter">
          <button type="button" className="secondaryButton" onClick={onCancel}>{t("back")}</button>
          {canConfirm && (
            <button type="button" className={danger ? "dangerButton" : "primaryButton"} disabled={busy || !ready || (!!acknowledgement && !acknowledged)} onClick={() => onConfirm(!!acknowledgement && acknowledged)}>
              {busy ? (ready ? t("processing") : t("preparingCancel")) : confirmLabel}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
