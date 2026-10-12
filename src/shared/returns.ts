// Calendar returns from the time-weighted return: each month's and each year's, chained from the last recorded day
// before it to its last recorded day, so deposits and withdrawals stay out of them as they do of the return itself.

import type { CalendarReturn, ReturnPoint } from "./history.js";

const round = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

/** The last day of the month ("2026-05") or year ("2026"). */
function lastDay(period: string): string {
  if (period.length === 4) return `${period}-12-31`;
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The last day before the month ("2026-05") or year ("2026") begins. */
function dayBefore(period: string): string {
  if (period.length === 4) return `${Number(period) - 1}-12-31`;
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
}

/**
 * Each calendar month's (`unit` "month", keyed "2026-05") or year's ("2026") return over the recorded days, oldest
 * first. A period starts from the last recorded day before it; the first one, with none before it, from its own first
 * recorded day, and is partial, as is one whose last recorded day is before its end or is `today` (a day not over yet).
 * One that starts from a recorded day before the end of the period before it is extended: with no reading in between,
 * its return takes in those days too. A first period with one recorded day has no return and is left out.
 */
export function calendarReturns(series: ReturnPoint[], unit: "month" | "year", today?: string): CalendarReturn[] {
  const keyOf = (date: string) => (unit === "month" ? date.slice(0, 7) : date.slice(0, 4));
  const out: CalendarReturn[] = [];
  let start = 0;
  while (start < series.length) {
    const key = keyOf(series[start]!.date);
    let end = start;
    while (end + 1 < series.length && keyOf(series[end + 1]!.date) === key) end++;
    const base = start > 0 ? series[start - 1]! : series[start]!;
    const last = series[end]!;
    if (start > 0 || end > start) {
      out.push({
        period: key,
        return: round((1 + last.return) / (1 + base.return) - 1),
        from: base.date,
        to: last.date,
        ...(start === 0 || last.date < lastDay(key) || (today !== undefined && last.date >= today) ? { partial: true as const } : {}),
        ...(start > 0 && base.date < dayBefore(key) ? { extended: true as const } : {}),
      });
    }
    start = end + 1;
  }
  return out;
}
