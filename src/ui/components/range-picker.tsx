// A window of the reader's own days beside the period switch: two date boxes drawn in the widget's style, checked
// before they are read. Days run midnight to midnight UTC, as the server reads a date and as the periods do.

import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { MessageKey, SupportedLocale } from "../i18n";
import { dayLabel } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { Field, Icon } from "./common";

/** First and last day, as YYYY-MM-DD. */
export interface DateRange { from: string; to: string }

/** The range the views read, and how to change it; given around the views whose period switch can take one. */
export const RangeContext = createContext<{ range: DateRange | null; onRange: (next: DateRange) => void; onClear: () => void; locale: SupportedLocale } | null>(null);

/** The earliest day the boxes take: Trading 212's history starts well after it. */
export const FIRST_DAY = "2000-01-01";

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** Why a range cannot be read, or nothing when it can. */
export function rangeProblem(range: { from: string; to: string }, today = todayUtc()): MessageKey | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return "rangeMissing";
  if (range.from > range.to) return "rangeOrder";
  if (range.to > today) return "rangeFuture";
  if (range.from < FIRST_DAY) return "rangeEarly";
  return undefined;
}

/** "3 Mar – 15 Apr 2026", the year once when both days share it. */
export function rangeLabel(range: DateRange, locale: SupportedLocale): string {
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return range.from === range.to ? dayLabel(range.to, locale) : `${dayLabel(range.from, locale, { year: !sameYear })} – ${dayLabel(range.to, locale)}`;
}

/** The last 30 days, to start from when no range was chosen yet. */
function lastMonth(today: string): DateRange {
  return { from: new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10), to: today };
}

export function RangePicker({ t, disabled }: { t: Translator; disabled: boolean }) {
  const context = useContext(RangeContext);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>({ from: "", to: "" });
  const [tried, setTried] = useState(false);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  if (!context) return null;
  const { range, onRange, onClear, locale } = context;
  const today = todayUtc();
  const problem = rangeProblem(draft, today);
  const close = () => { setOpen(false); setTried(false); button.current?.focus(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || disabled) return;
    close();
    if (range?.from !== draft.from || range?.to !== draft.to) onRange(draft);
  };
  const label = range ? rangeLabel(range, locale) : undefined;
  return (
    <>
      <button ref={button} type="button" className={`rangeButton${range ? " active" : ""}`} aria-expanded={open} aria-controls={id}
        aria-label={label ? fill(t("rangeActive"), { range: label }) : t("rangeCustom")} title={label ? fill(t("rangeActive"), { range: label }) : t("rangeCustom")}
        onClick={() => { if (open) { close(); return; } setDraft(range ?? lastMonth(today)); setOpen(true); }}>
        <Icon name="calendar" />{label && <span>{label}</span>}
      </button>
      {open && (
        <form id={id} className="rangePanel" noValidate onSubmit={submit} aria-label={t("rangeCustom")}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
          <div className="rangeFields">
            <Field label={t("rangeFrom")}>
              {(props) => <input {...props} ref={first} type="date" value={draft.from} min={FIRST_DAY} max={draft.to && draft.to <= today ? draft.to : today} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />}
            </Field>
            <Field label={t("rangeTo")} {...(tried && problem ? { error: t(problem) } : {})}>
              {(props) => <input {...props} type="date" value={draft.to} min={draft.from || FIRST_DAY} max={today} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />}
            </Field>
          </div>
          <p className="rangeNote">{t("rangeNote")}</p>
          <div className="rangeActions">
            {range && <button type="button" className="linkButton" disabled={disabled} onClick={() => { close(); onClear(); }}>{t("rangeClear")}</button>}
            <button type="button" className="secondaryButton" onClick={close}>{t("cancel")}</button>
            <button type="submit" className="primaryButton" aria-disabled={disabled || undefined}>{t("rangeApply")}</button>
          </div>
        </form>
      )}
    </>
  );
}
