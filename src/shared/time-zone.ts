// Days and hours in a time zone (an IANA name such as Europe/London), without a time-zone library: the offset is read
// from Intl at each instant, so summer time is followed.

/** "MM-DD" → month and day; the default is the calendar year. */
export function parseYearStart(value: string | undefined): { month: number; day: number; text: string } {
  const match = /^(\d{2})-(\d{2})$/.exec(value?.trim() ?? "01-01");
  const month = Number(match?.[1]), day = Number(match?.[2]);
  const valid = match && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(2001, month, 0)).getUTCDate();
  return valid ? { month, day, text: `${match[1]}-${match[2]}` } : { month: 1, day: 1, text: "01-01" };
}

/** Whether `timeZone` is an IANA zone this runtime knows, such as Europe/London. */
export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds that local time in `timeZone` is ahead of UTC at `instant`. */
export function zoneOffset(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(instant / 1000) * 1000;
}

/** The local calendar date of an instant in `timeZone`, as YYYY-MM-DD. */
export function localDay(instant: number, timeZone: string): string {
  return new Date(instant + zoneOffset(instant, timeZone)).toISOString().slice(0, 10);
}

/** The instant a local calendar day starts in `timeZone`. */
export function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffset(guess, timeZone);
  // A second pass settles days where the offset changes between the guess and local midnight.
  const midnight = guess - zoneOffset(first, timeZone);
  // Where clocks jump forward at midnight (Santiago, Havana) there is no 00:00: that lands on the previous day's last
  // hour, and the day starts when the clocks jump, the jump later.
  const target = new Date(guess).toISOString().slice(0, 10);
  if (localDay(midnight, timeZone) >= target) return midnight;
  return midnight + zoneOffset(midnight + 6 * 3_600_000, timeZone) - zoneOffset(midnight, timeZone);
}

/**
 * The instant a local day's `hour` o'clock starts in `timeZone` (`day` as YYYY-MM-DD). An hour the clocks skip in
 * spring is the first instant after the jump, so a plan due then is due as soon as that hour's time exists.
 */
export function localHourStart(day: string, hour: number, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, date, hour);
  const first = guess - zoneOffset(guess, timeZone);
  const instant = guess - zoneOffset(first, timeZone);
  if (localDay(instant, timeZone) === day && localHour(instant, timeZone) === hour) return instant;
  // In the gap: the offset after the jump, from an instant safely past it.
  const later = zoneOffset(instant + 3 * 3_600_000, timeZone);
  return Math.max(instant, guess - later);
}

/** The local hour (0 to 23) of an instant in `timeZone`. */
export function localHour(instant: number, timeZone: string): number {
  return new Date(instant + zoneOffset(instant, timeZone)).getUTCHours();
}

/** The zone a tax year from a known first day is counted in, where there is one: the UK's, from 6 April, in London. */
const TAX_YEAR_ZONES: Record<string, string> = { "04-06": "Europe/London" };

export function taxYearZone(yearStart: string | undefined): string | undefined {
  return yearStart ? TAX_YEAR_ZONES[yearStart] : undefined;
}
