// A month of days to choose a range from, drawn by the widget in place of the browser's date popup (a system
// calendar on a computer, a wheel or a full-screen sheet on a phone). The first press chooses the first day and the
// next the last; until then the days up to the one under the pointer or focus show as the range. Days are UTC dates,
// YYYY-MM-DD, as the range picker reads them; weeks start on Monday.
//
// The keyboard follows the ARIA date grid: one Tab stop on the focused day; the arrows move by a day or a week, Home
// and End to the week's ends, Page Up and Page Down by a month (with Shift, a year), Enter or Space chooses.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { localeTag, type SupportedLocale } from "../i18n";
import type { Translator } from "../lib/messages";
import { Icon } from "./common";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** A day on the calendar as YYYY-MM-DD: not 2026-02-31, as one typed can be. */
export function realDay(day: string): boolean {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** `day` moved by `days`, or by whole months (the day kept, or the month's last when it has fewer). */
export function shiftDay(day: string, { days = 0, months = 0 }: { days?: number; months?: number }): string {
  if (months) {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    const target = new Date(Date.UTC(year, month - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return iso(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date, last)));
  }
  return iso(parse(day) + days * DAY_MS);
}

/** The weeks of the month `month` (YYYY-MM), Monday first, each a row of seven days or nulls outside the month. */
export function monthWeeks(month: string): (string | null)[][] {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const first = Date.UTC(year, index - 1, 1);
  const length = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length }, (_, day) => iso(first + day * DAY_MS))];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** The range after choosing `day`: it starts a new range, unless one is begun and `day` is not before its first. */
export function pickDay(range: { from: string; to: string }, day: string): { from: string; to: string } {
  // A first day still being typed ("2026-1") has not begun one.
  return realDay(range.from) && !realDay(range.to) && day >= range.from ? { from: range.from, to: day } : { from: day, to: "" };
}

const clamp = (day: string, min: string, max: string) => (day < min ? min : day > max ? max : day);

export function RangeCalendar({ from: typedFrom, to: typedTo, min, max, today, locale, t, onPick }: {
  from: string; to: string; min: string; max: string; today: string; locale: SupportedLocale; t: Translator;
  onPick: (range: { from: string; to: string }) => void;
}) {
  // What is drawn: the days of the boxes that are days, not one half typed.
  const from = realDay(typedFrom) ? typedFrom : "";
  const to = realDay(typedTo) ? typedTo : "";
  const [focus, setFocus] = useState(() => clamp(to || from || max, min, max));
  const [hover, setHover] = useState<string | null>(null);
  const month = focus.slice(0, 7);
  const grid = useRef<HTMLTableElement>(null);
  // Set by a key that moved the focused day, so the day reached takes the focus once it is drawn.
  const [moves, setMoves] = useState(0);
  // A day typed in either box shows its month, the box typed in last deciding.
  const typing = (day: string) => { if (day && !grid.current?.contains(document.activeElement)) setFocus(clamp(day, min, max)); };
  useEffect(() => typing(from), [from]);
  useEffect(() => typing(to), [to]);
  useLayoutEffect(() => {
    if (moves) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [moves]);

  const tag = localeTag(locale);
  const title = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" }).format(parse(`${month}-01`));
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const day = Date.UTC(2024, 0, 1 + index); // 1 January 2024 was a Monday.
    return { short: new Intl.DateTimeFormat(tag, { weekday: "narrow", timeZone: "UTC" }).format(day), long: new Intl.DateTimeFormat(tag, { weekday: "long", timeZone: "UTC" }).format(day) };
  }), [tag]);
  const full = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  // The range drawn: the one chosen, or while the last day is still to choose, up to the day pointed at.
  const end = to || (from && hover && hover >= from ? hover : "");
  const go = (day: string) => {
    const next = clamp(day, min, max);
    if (next === focus) return;
    setFocus(next);
    setMoves((count) => count + 1);
  };
  const keys = (event: KeyboardEvent<HTMLTableElement>) => {
    const steps: Record<string, { days?: number; months?: number }> = {
      ArrowRight: { days: 1 }, ArrowLeft: { days: -1 }, ArrowDown: { days: 7 }, ArrowUp: { days: -7 },
      PageDown: { months: event.shiftKey ? 12 : 1 }, PageUp: { months: event.shiftKey ? -12 : -1 },
    };
    const weekday = (new Date(parse(focus)).getUTCDay() + 6) % 7;
    const step = steps[event.key] ?? (event.key === "Home" ? { days: -weekday } : event.key === "End" ? { days: 6 - weekday } : undefined);
    if (!step) return;
    event.preventDefault();
    go(shiftDay(focus, step));
  };
  // The month buttons stay focusable at the ends (marked, not disabled), so the focus is not dropped from the panel
  // when one reaches the first or last month.
  const first = month <= min.slice(0, 7);
  const last = month >= max.slice(0, 7);
  const monthStep = (months: number) => { if (!(months < 0 ? first : last)) setFocus(clamp(shiftDay(focus, { months }), min, max)); };
  return (
    <div className="calendar">
      <div className="calendarHead">
        <button type="button" className="calendarStep" aria-label={t("calendarPrevious")} title={t("calendarPrevious")} aria-disabled={first || undefined} onClick={() => monthStep(-1)}>
          <Icon name="arrow" className="flip" />
        </button>
        <strong aria-live="polite">{title}</strong>
        <button type="button" className="calendarStep" aria-label={t("calendarNext")} title={t("calendarNext")} aria-disabled={last || undefined} onClick={() => monthStep(1)}>
          <Icon name="arrow" />
        </button>
      </div>
      <table ref={grid} role="grid" aria-label={title} className="calendarGrid" onKeyDown={keys} onMouseLeave={() => setHover(null)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHover(null); }}>
        <thead>
          <tr>{weekdays.map((day) => <th key={day.long} scope="col" abbr={day.long}>{day.short}</th>)}</tr>
        </thead>
        <tbody>
          {monthWeeks(month).map((week, row) => (
            <tr key={row}>
              {week.map((day, column) => {
                if (!day) return <td key={column} />;
                const outside = day < min || day > max;
                // Selected are the days chosen; the days up to the one pointed at are drawn as the range, not chosen.
                const chosen = day === from || day === to || Boolean(from && to && day > from && day < to);
                const inside = Boolean(from && end && day > from && day < end);
                const kind = [day === from ? "start" : "", day === end ? "end" : "", inside ? "inside" : "", day === today ? "today" : ""].filter(Boolean).join(" ");
                return (
                  <td key={day} role="gridcell" aria-selected={chosen} className={kind || undefined}>
                    <button type="button" data-day={day} tabIndex={day === focus ? 0 : -1} disabled={outside} aria-label={full.format(parse(day))}
                      {...(day === today ? { "aria-current": "date" as const } : {})}
                      onClick={() => { setFocus(day); onPick(pickDay({ from: typedFrom, to: typedTo }, day)); }} onMouseEnter={() => setHover(day)} onFocus={() => setHover(day)}>
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
