// A window of the reader's own days beside the period switch: two date boxes drawn in the widget's style, checked
// before they are read. Days run midnight to midnight UTC, as the server reads a date and as the periods do; "today"
// is the reader's own date, which may be a UTC day ahead or behind.

import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { MessageKey, SupportedLocale } from "../i18n";
import { dayLabel } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { RangeCalendar, realDay } from "./calendar";
import { Field, Icon } from "./common";

/**
 * First and last day, as YYYY-MM-DD. A window the host read keeps its own bounds in `exact`, so reading it again
 * reads the same; days the reader chooses are whole days.
 */
export interface DateRange { from: string; to: string; exact?: { from: string; to: string } }

/** The range the views read, and how to change it; given around the views whose period switch can take one. */
export const RangeContext = createContext<{ range: DateRange | null; onRange: (next: DateRange) => void; onClear: () => void; locale: SupportedLocale } | null>(null);

/** The earliest day the boxes take: Trading 212's history starts well after it. */
export const FIRST_DAY = "2000-01-01";

/** The reader's own date, as YYYY-MM-DD. */
export const todayLocal = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Why a range cannot be read, or nothing when it can. */
export function rangeProblem(range: { from: string; to: string }, today = todayLocal()): MessageKey | undefined {
  // A day that is not on the calendar (2026-02-31), as one typed can be, is no day at all.
  if (!realDay(range.from) || !realDay(range.to)) return "rangeMissing";
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
function lastMonth(today: string): { from: string; to: string } {
  return { from: new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10), to: today };
}

export function RangePicker({ t, disabled }: { t: Translator; disabled: boolean }) {
  const context = useContext(RangeContext);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const last = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [tried, setTried] = useState(false);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  if (!context) return null;
  const { range, onRange, onClear, locale } = context;
  const today = todayLocal();
  const problem = rangeProblem(draft, today);
  // The box a problem is about: the first day's when it is missing or too early, else the last day's.
  const onFirst = problem === "rangeEarly" || (problem === "rangeMissing" && !realDay(draft.from));
  const close = () => { setOpen(false); setTried(false); button.current?.focus(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    // The box that is wrong takes the focus, so its message is read out with it.
    if (problem) { (onFirst ? first : last).current?.focus(); return; }
    if (disabled) return;
    close();
    if (range?.from !== draft.from || range?.to !== draft.to) onRange({ from: draft.from, to: draft.to });
  };
  const label = range ? rangeLabel(range, locale) : undefined;
  return (
    // Escape closes the panel from the button too, not only from inside it.
    <div className="rangePicker" onKeyDown={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <button ref={button} type="button" className={`rangeButton${range ? " active" : ""}`} aria-expanded={open} {...(open ? { "aria-controls": id } : {})}
        aria-label={label ? fill(t("rangeActive"), { range: label }) : t("rangeCustom")} title={label ? fill(t("rangeActive"), { range: label }) : t("rangeCustom")}
        onClick={() => { if (open) { close(); return; } setDraft(range ? { from: range.from, to: range.to } : lastMonth(today)); setOpen(true); }}>
        <Icon name="calendar" />{label && <span>{label}</span>}
      </button>
      {open && (
        <form id={id} className="rangePanel" noValidate onSubmit={submit} aria-label={t("rangeCustom")}>
          <p className="rangeNote">{t("rangePick")}</p>
          <RangeCalendar from={draft.from} to={draft.to} min={FIRST_DAY} max={today} today={today} locale={locale} t={t} onPick={setDraft} />
          {/* The days typed, as year-month-day: plain text boxes, as a date box would open the browser's own calendar. */}
          <div className="rangeFields">
            <Field label={t("rangeFrom")} {...(tried && problem && onFirst ? { error: t(problem) } : {})}>
              {(props) => <input {...props} ref={first} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={10} placeholder="YYYY-MM-DD" className="dayInput"
                value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value.trim() })} />}
            </Field>
            <Field label={t("rangeTo")} {...(tried && problem && !onFirst ? { error: t(problem) } : {})}>
              {(props) => <input {...props} ref={last} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={10} placeholder="YYYY-MM-DD" className="dayInput"
                value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value.trim() })} />}
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
    </div>
  );
}
