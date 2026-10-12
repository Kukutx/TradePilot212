import { useState } from "react";
import type { HoldingFill } from "../../shared/holding";
import { journalTags, journalText, MAX_JOURNAL_TEXT, type JournalEntry } from "../../shared/journal";
import type { SupportedLocale } from "../i18n";
import { amount, dayLabel, qty } from "../lib/format";
import { fill, orderTypeLabel, type Translator } from "../lib/messages";
import { Field } from "./common";

/** What the journal form sends. For a note that exists, an empty value clears that part. */
export interface JournalRequest {
  thesis: string;
  review: string;
  tags: string[];
}

/** Tags as typed: separated by commas (either width), the Chinese list comma, or new lines. */
export function parseTags(text: string): string[] {
  return journalTags(text.split(/[,，、\n]/)) ?? [];
}

/**
 * The order a note is about: the listed fill (its side, size, price and day), else the order as it was sent,
 * else just its id. A note on no order has none.
 */
export function noteOrder(entry: JournalEntry, fills: HoldingFill[], locale: SupportedLocale, t: Translator): { label: string; side?: "buy" | "sell"; at?: string } | undefined {
  const filled = entry.orderId ? fills.find((item) => item.orderId === entry.orderId) : undefined;
  if (filled) {
    const side = String(filled.side ?? "").toUpperCase() === "SELL" || (filled.quantity ?? 0) < 0 ? "sell" : "buy";
    return { label: `${side === "sell" ? t("sell") : t("buy")} ${qty(Math.abs(filled.quantity ?? 0), locale)} · ${amount(filled.price, filled.priceCurrency, locale)}`, side, ...(filled.filledAt ? { at: filled.filledAt } : {}) };
  }
  if (entry.order) return { label: `${entry.order.side === "sell" ? t("sell") : t("buy")} ${qty(entry.order.quantity, locale)} · ${orderTypeLabel(entry.order.type, t)}`, side: entry.order.side };
  return entry.orderId ? { label: fill(t("journalOnOrder"), { id: entry.orderId }) } : undefined;
}

/** A new note, or a change to one. It needs a reason or a look back; tags are optional. */
export function JournalForm({ entry, focus, t, busy, onSave, onCancel }: {
  entry?: JournalEntry;
  /** Start in the look-back field, for a note that has only a reason. */
  focus?: "review";
  t: Translator;
  busy: boolean;
  onSave: (request: JournalRequest) => void;
  onCancel: () => void;
}) {
  const [thesis, setThesis] = useState(entry?.thesis ?? "");
  const [review, setReview] = useState(entry?.review ?? "");
  const [tagText, setTagText] = useState(entry?.tags?.join(", ") ?? "");
  const [touched, setTouched] = useState(false);
  const empty = !journalText(thesis) && !journalText(review);
  const submit = () => {
    setTouched(true);
    if (empty || busy) return;
    onSave({ thesis: journalText(thesis) ?? "", review: journalText(review) ?? "", tags: parseTags(tagText) });
  };
  return (
    <form className="alertForm journalForm" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="formGrid">
        <Field label={t("journalWhy")} hint={t("journalWhyHint")} {...(touched && empty ? { error: t("journalNeedsText") } : {})}>
          {(props) => <textarea {...props} rows={3} maxLength={MAX_JOURNAL_TEXT} autoFocus={focus !== "review"} value={thesis} onChange={(event) => setThesis(event.target.value)} />}
        </Field>
        <Field label={t("journalReview")} hint={t("journalReviewHint")}>
          {(props) => <textarea {...props} rows={3} maxLength={MAX_JOURNAL_TEXT} autoFocus={focus === "review"} value={review} onChange={(event) => setReview(event.target.value)} />}
        </Field>
        <Field label={t("journalTags")} hint={t("journalTagsHint")}>
          {(props) => <input {...props} autoComplete="off" maxLength={200} value={tagText} onChange={(event) => setTagText(event.target.value)} />}
        </Field>
      </div>
      <p className="panelNote">{t("journalOnlyHere")}</p>
      <div className="alertFormActions">
        <button type="button" className="secondaryButton" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primaryButton" disabled={busy} aria-disabled={Boolean(touched && empty) || undefined}>{busy ? t("saving") : t("journalSave")}</button>
      </div>
    </form>
  );
}

/** One note: the order it is about, the reason, the look back and the tags, with edit and delete. */
export function JournalNote({ entry, fills, locale, t, busy, onEdit, onDelete }: {
  entry: JournalEntry;
  fills: HoldingFill[];
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onEdit: (focus?: "review") => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const order = noteOrder(entry, fills, locale, t);
  return (
    <li className="journalNote">
      <div className="journalHead">
        {/* The day of the trade when its fill is listed, else the day the note was written. */}
        <strong>{dayLabel(order?.at ?? entry.createdAt, locale)}</strong>
        {order && <span className={`journalOrder ${order.side ?? ""}`}>{order.label}</span>}
        {entry.order?.unconfirmed && <span className="statusPill fired">{t("journalUnconfirmed")}</span>}
      </div>
      {entry.thesis && <div className="journalText"><span>{t("journalWhy")}</span><p>{entry.thesis}</p></div>}
      {entry.review && <div className="journalText review"><span>{t("journalReview")}</span><p>{entry.review}</p></div>}
      {entry.tags?.length ? <div className="journalTags">{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
      {confirming ? (
        <div className="alertActions" role="group" aria-label={t("journalDeleteConfirm")}>
          <span className="mutedInline">{t("journalDeleteConfirm")}</span>
          <button type="button" className="linkButton" disabled={busy} onClick={() => setConfirming(false)}>{t("journalKeep")}</button>
          <button type="button" className="linkButton danger" disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>{t("journalDelete")}</button>
        </div>
      ) : (
        <div className="alertActions">
          {entry.updatedAt && <span className="mutedInline journalEdited">{fill(t("journalEdited"), { date: dayLabel(entry.updatedAt, locale) })}</span>}
          {!entry.review && <button type="button" className="linkButton" disabled={busy} onClick={() => onEdit("review")}>{t("journalAddReview")}</button>}
          <button type="button" className="linkButton" disabled={busy} onClick={() => onEdit()}>{t("journalEdit")}</button>
          <button type="button" className="linkButton danger" disabled={busy} onClick={() => setConfirming(true)}>{t("journalDelete")}</button>
        </div>
      )}
    </li>
  );
}
