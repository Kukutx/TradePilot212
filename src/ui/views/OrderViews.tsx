import { useState } from "react";
import type { PolicyCheck } from "../../shared/automation";
import type { CancelPreview, Instrument, OrderDraft, OrderPreview, OrderResolution } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import { DetailRow, Field, Icon } from "../components/common";
import { dateTime, num, money, time } from "../lib/format";
import { noticeText, policyRuleLabel, policyStatusLabel, sizingText, type Translator } from "../lib/messages";

const POLICY_GLYPH: Record<PolicyCheck["status"], string> = { pass: "✓", warn: "!", skip: "–", block: "✕" };

/** Policy results with an icon and a status word, so the outcome never depends on color alone. */
export function PolicyList({ checks, t }: { checks?: PolicyCheck[]; t: Translator }) {
  if (!checks?.length) return null;
  const order: PolicyCheck["status"][] = ["block", "warn", "skip"];
  const flagged = checks.filter((check) => check.status !== "pass").sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const passed = checks.filter((check) => check.status === "pass");
  const row = (check: PolicyCheck, index: number) => (
    <li className={`policyCheck ${check.status}`} key={`${check.rule}-${index}`}>
      <span className="policyGlyph" aria-hidden="true">{POLICY_GLYPH[check.status] ?? "?"}</span>
      <span className="policyCopy">
        <strong>{policyStatusLabel(check.status, t)} · {policyRuleLabel(check.rule, t)}</strong>
        {check.message && <span>{check.message}</span>}
      </span>
    </li>
  );
  return (
    <div className="policyBlock" aria-label={t("policyChecks")}>
      <span className="policyTitle">{t("policyChecks")}</span>
      {flagged.length > 0 && <ul className="policyList">{flagged.map(row)}</ul>}
      {passed.length > 0 && (
        <details className="policyPassed">
          <summary><span className="policyGlyph" aria-hidden="true">✓</span>{passed.length} {t("policyPassedCount")}</summary>
          <ul className="policyList">{passed.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

export function OrderEditor({
  draft,
  originalDraft,
  resolution,
  resolvedInstrument,
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
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onChange: (draft: OrderDraft) => void;
  onClose: () => void;
  onReview: () => void;
}) {
  const set = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) => onChange({ ...draft, [key]: value });
  const quantityEdited = resolution ? Math.abs(draft.quantity - resolution.resolvedQuantity) > 1e-8 : false;
  const orderEdited = originalDraft ? (["side", "type", "quantity", "extendedHours", "timeValidity", "limitPrice", "stopPrice", "referencePrice"] as const).some((key) => originalDraft[key] !== draft[key]) : quantityEdited;
  return (
    <main className="transactionStage">
      <section className={`transactionPanel ${draft.environment === "live" ? "liveTransaction" : ""}`} aria-label={t("orderDraft")}>
        <div className="transactionHeader">
          <div><span className={`environmentTag ${draft.environment}`}>{draft.environment.toUpperCase()}</span><h2>{t("orderDraft")}</h2><p>{draft.ticker}</p></div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        {resolution && (
          <div className="resolutionCard">
            <div><span>{t("resolvedFromRequest")}</span><strong>{sizingText(resolution.sizing, resolvedInstrument, locale, t)}</strong></div>
            <div><span>{t("calculatedQuantity")}</span><strong>{num(resolution.resolvedQuantity, locale)}</strong></div>
            {orderEdited && <div className="resolutionEdited"><span>{t("manualEdited")}</span><strong>{quantityEdited ? num(draft.quantity, locale) : t("otherFieldsChanged")}</strong>{quantityEdited && <button type="button" onClick={() => set("quantity", resolution.resolvedQuantity)}>{t("restoreCalculated")}</button>}</div>}
          </div>
        )}
        <div className="formGrid">
          <Field label={t("side")}><select value={draft.side} onChange={(event) => set("side", event.target.value as OrderDraft["side"])}><option value="buy">{t("buy")}</option><option value="sell">{t("sell")}</option></select></Field>
          <Field label={t("type")}><select value={draft.type} onChange={(event) => set("type", event.target.value as OrderDraft["type"])}><option value="market">{t("market")}</option><option value="limit">{t("limit")}</option><option value="stop">{t("stop")}</option><option value="stop_limit">{t("stopLimit")}</option></select></Field>
          <Field label={t("quantity")}><input type="number" min="0" step="any" value={draft.quantity} onChange={(event) => set("quantity", Number(event.target.value))} /></Field>
          <Field label={t("referencePrice")}><input type="number" min="0" step="any" value={draft.referencePrice ?? ""} placeholder="—" onChange={(event) => onChange({ ...draft, referencePrice: event.target.value ? Number(event.target.value) : undefined, referencePriceAt: undefined })} /></Field>
          {(draft.type === "limit" || draft.type === "stop_limit") && <Field label={t("limitPrice")}><input type="number" min="0" step="any" value={draft.limitPrice ?? ""} onChange={(event) => set("limitPrice", event.target.value ? Number(event.target.value) : undefined)} /></Field>}
          {(draft.type === "stop" || draft.type === "stop_limit") && <Field label={t("stopPrice")}><input type="number" min="0" step="any" value={draft.stopPrice ?? ""} onChange={(event) => set("stopPrice", event.target.value ? Number(event.target.value) : undefined)} /></Field>}
          {draft.type !== "market" && <Field label={t("validity")}><select value={draft.timeValidity ?? "DAY"} onChange={(event) => set("timeValidity", event.target.value as OrderDraft["timeValidity"])}><option value="DAY">{t("day")}</option><option value="GOOD_TILL_CANCEL">{t("gtc")}</option></select></Field>}
          {draft.type === "market" && <label className="toggleField"><input type="checkbox" checked={draft.extendedHours ?? false} onChange={(event) => set("extendedHours", event.target.checked)} /><span className="toggleTrack"><span /></span><span>{t("extendedHours")}</span></label>}
        </div>
        <div className="transactionFooter"><button className="secondaryButton" onClick={onClose}>{t("cancel")}</button><button className="primaryButton" disabled={busy} onClick={onReview}>{busy ? t("checking") : t("reviewOrder")}</button></div>
        <span className="visuallyHidden">{locale}</span>
      </section>
    </main>
  );
}

/** What a cancellation removes, e.g. "Sell 5 NVDA_US_EQ · Stop · @ 110 · Order 123". */
export function cancelDescription(preview: CancelPreview, t: Translator, locale: SupportedLocale): string {
  const order = preview.order;
  if (!order?.ticker) return `${t("order")} ${preview.orderId}`;
  const quantity = order.quantity ?? 0;
  const sell = String(order.side ?? "").toUpperCase() === "SELL" || quantity < 0;
  const type = String(order.type ?? "").toUpperCase();
  const typeLabel = type === "LIMIT" ? t("limit") : type === "STOP" ? t("stop") : type === "STOP_LIMIT" ? t("stopLimit") : type === "MARKET" ? t("market") : type;
  const price = order.limitPrice ?? order.stopPrice;
  return [`${sell ? t("sell") : t("buy")} ${num(Math.abs(quantity), locale)} ${order.ticker}`, typeLabel, price ? `@ ${num(price, locale)}` : "", `${t("order")} ${preview.orderId}`]
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
  locale,
  t,
  busy,
  onBack,
  onConfirm,
}: {
  preview: OrderPreview;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const draft = preview.draft;
  const live = draft.environment === "live";
  const [acknowledged, setAcknowledged] = useState(false);
  const amountCurrency = preview.estimatedNotionalCurrency || preview.instrument.currencyCode;
  return (
    <main className="transactionStage">
      <section className={`transactionPanel confirmationPanel ${draft.environment === "live" ? "liveTransaction" : ""}`} aria-label={t("finalConfirmation")}>
        <div className="confirmationHero">
          <span className={`environmentTag ${draft.environment}`}>{draft.environment.toUpperCase()}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")}</span>
          <h2>{draft.environment === "live" ? t("realOrder") : t("demoOrder")}</h2>
          <strong className="confirmationAmount">{money(preview.estimatedNotional, amountCurrency, locale)}</strong>
        </div>
        <div className="confirmationRows">
          <DetailRow label={t("instrument")} value={`${preview.instrument.shortName || preview.instrument.name} · ${draft.ticker}`} />
          <DetailRow label={t("side")} value={draft.side === "buy" ? t("buy") : t("sell")} />
          <DetailRow label={t("type")} value={draft.type === "market" ? t("market") : draft.type === "limit" ? t("limit") : draft.type === "stop" ? t("stop") : t("stopLimit")} />
          <DetailRow label={t("quantity")} value={num(draft.quantity, locale)} />
          {draft.limitPrice && <DetailRow label={t("limitPrice")} value={num(draft.limitPrice, locale)} />}
          {draft.stopPrice && <DetailRow label={t("stopPrice")} value={num(draft.stopPrice, locale)} />}
          {draft.referencePriceAt && <DetailRow label={t("referenceAsOf")} value={dateTime(draft.referencePriceAt, locale)} />}
          {draft.fxRateAt && <DetailRow label={t("fxAsOf")} value={dateTime(draft.fxRateAt, locale)} />}
          <DetailRow label={t("snapshotAsOf")} value={dateTime(preview.snapshotAt, locale)} />
        </div>
        {(preview.notices ?? []).map((notice) => <div className="notice warning compactNotice" key={notice.code}>{noticeText(notice, t, locale)}</div>)}
        <PolicyList checks={preview.policy} t={t} />
        <div className="expiryLine">{t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter"><button className="secondaryButton" onClick={onBack}>{t("backToEdit")}</button><button className={live ? "dangerButton" : "primaryButton"} disabled={busy || (live && !acknowledged) || (preview.policy ?? []).some((check) => check.status === "block")} onClick={() => onConfirm(live && acknowledged)}>{busy ? t("submitting") : draft.environment === "live" ? t("confirmLive") : t("confirmDemo")}</button></div>
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
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  danger: boolean;
  confirmLabel: string;
  busy: boolean;
  t: Translator;
  /** When set, a checkbox with this text must be ticked before confirming. */
  acknowledgement?: string;
  onCancel: () => void;
  onConfirm: (acknowledged: boolean) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <main className="transactionStage">
      <section className={`transactionPanel smallDialog ${danger ? "liveTransaction" : ""}`} aria-label={title}>
        <h2>{title}</h2><p>{body}</p>
        {acknowledgement && (
          <label className="liveAck">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>{acknowledgement}</span>
          </label>
        )}
        <div className="transactionFooter"><button type="button" className="secondaryButton" onClick={onCancel}>{t("back")}</button><button type="button" className={danger ? "dangerButton" : "primaryButton"} disabled={busy || (!!acknowledgement && !acknowledged)} onClick={() => onConfirm(!!acknowledgement && acknowledged)}>{busy ? t("processing") : confirmLabel}</button></div>
      </section>
    </main>
  );
}
