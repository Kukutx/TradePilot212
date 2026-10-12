// When dividends come: each holding's usual spacing between payments, read from its payments of the last year, and
// the payments that spacing implies at the current quantity. Pure functions; the clock is passed in.

const DAY = 86_400_000;
/** Entries this close to a payday's first are part of it. */
const SAME_PAYDAY_DAYS = 10;
/** The same for a holding that pays every week or two, whose paydays are closer than that. */
const SAME_PAYDAY_DAYS_WEEKLY = 3;

/** One payment, per share: net of withholding tax and in the account currency, as Trading 212 pays it. */
export interface PaidDividend { at: number; perShare: number; amount?: number; quantity?: number }

/** Payments a year: weekly, every two weeks, monthly, quarterly, half-yearly or yearly. */
export type DividendFrequency = 52 | 26 | 12 | 4 | 2 | 1;

export interface DividendSchedule {
  /** The paydays read, oldest first, each with a positive amount per share. */
  payments: PaidDividend[];
  /** Payments a year, from the median spacing between paydays; none from a single payday. */
  frequency?: DividendFrequency;
  /** A year's payments per share: the newest year's paydays, scaled up to the frequency when there are fewer. */
  annualPerShare: number;
  /** Most paydays fall on a month's last day, so the next ones are expected on month ends too. */
  monthEnd?: boolean;
}

/** An expected payment: when, about (midnight UTC), and how much at the current quantity, in the account currency. */
export interface ExpectedPayment { at: number; amount: number }

/** The same day `months` months on (or back), or the month's last day where it is shorter; midnight UTC. */
export function addMonths(at: number, months: number): number {
  const date = new Date(at);
  const month = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return Date.UTC(date.getUTCFullYear(), month, Math.min(date.getUTCDate(), last));
}

/** The first day of the month `at` is in, midnight UTC. */
export const monthStart = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

const dayStart = (at: number) => Math.floor(at / DAY) * DAY;
const monthEnd = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
};

/**
 * Where a schedule's payments are read from: the first day of this month a year ago, so last year's payment of a
 * holding due again this month is seen even when it came a few days earlier in the month.
 */
export const scheduleStart = (now: number) => addMonths(monthStart(now), -12);

/** One payday's amount per share from its entries. */
function paydayPerShare(entries: PaidDividend[]): number {
  if (entries.length === 1) return entries[0]!.perShare;
  // On the same shares, entries are separate payments (a special dividend beside the regular one) and add up; on
  // different numbers of shares, one payment made on parts of the holding, so its total over their shares.
  const quantities = new Set(entries.map((entry) => entry.quantity));
  if (quantities.size > 1 && entries.every((entry) => entry.amount !== undefined && entry.quantity)) {
    return entries.reduce((sum, entry) => sum + entry.amount!, 0) / entries.reduce((sum, entry) => sum + entry.quantity!, 0);
  }
  return entries.reduce((sum, entry) => sum + entry.perShare, 0);
}

/** Entries grouped into paydays (within `days` of a payday's first entry), a correction on its own day counted against the payday before it. */
function paydays(entries: PaidDividend[], days: number): PaidDividend[] {
  const groups: PaidDividend[][] = [];
  for (const item of entries) {
    const group = groups[groups.length - 1];
    if (group && item.at - group[0]!.at <= days * DAY) group.push(item);
    else groups.push([item]);
  }
  const result: PaidDividend[] = [];
  for (const group of groups) {
    const perShare = paydayPerShare(group);
    if (perShare > 0) result.push({ at: group[0]!.at, perShare });
    else if (result.length) result[result.length - 1]!.perShare += perShare;
  }
  return result.filter((day) => day.perShare > 0);
}

const spacings = (payments: PaidDividend[]) => payments.slice(1).map((item, index) => (item.at - payments[index]!.at) / DAY).sort((a, b) => a - b);

/** A holding's schedule from its payments since `scheduleStart`; none without a payday that paid. */
export function dividendSchedule(paid: PaidDividend[]): DividendSchedule | undefined {
  const entries = [...paid].filter((entry) => Number.isFinite(entry.at) && Number.isFinite(entry.perShare)).sort((a, b) => a.at - b.at);
  // Every week or two only when the paydays bear it out: at least six, and three in four spaced under three weeks.
  // Otherwise entries days apart (a special dividend after the regular one, an adjustment) belong to one payday.
  const close = paydays(entries, SAME_PAYDAY_DAYS_WEEKLY);
  const closeGaps = spacings(close);
  const weekly = close.length >= 6 && closeGaps.filter((gap) => gap < 21).length >= closeGaps.length * 0.75;
  const payments = weekly ? close : paydays(entries, SAME_PAYDAY_DAYS);
  if (!payments.length) return undefined;
  const gaps = weekly ? closeGaps : spacings(payments);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : undefined;
  const frequency: DividendFrequency | undefined = gap === undefined ? undefined
    : weekly ? (gap < 10 ? 52 : 26) : gap < 45 ? 12 : gap < 135 ? 4 : gap < 270 ? 2 : 1;
  // The newest year's paydays: a schedule read over a little more than a year can hold one payment twice.
  const count = frequency ?? 1;
  const recent = payments.slice(-count);
  const sum = recent.reduce((total, item) => total + item.perShare, 0);
  const ends = payments.filter((item) => monthEnd(dayStart(item.at)) === dayStart(item.at)).length;
  return {
    payments,
    ...(frequency ? { frequency } : {}),
    annualPerShare: recent.length < count ? (sum * count) / recent.length : sum,
    ...(ends >= 2 && ends >= payments.length * 0.75 ? { monthEnd: true } : {}),
  };
}

/** The `k`th payday after `last` at the schedule's spacing; a holding that pays on months' last days keeps to them. */
function stepper(last: number, frequency: DividendFrequency, atMonthEnd: boolean): { step: (k: number) => number; days: number; yearBefore: (at: number) => number } {
  const from = dayStart(last);
  if (frequency >= 26) {
    const days = 364 / frequency;
    return { step: (k) => from + k * days * DAY, days, yearBefore: (at) => at - 364 * DAY };
  }
  const months = 12 / frequency;
  return {
    step: (k) => (atMonthEnd ? monthEnd(addMonths(monthStart(from), k * months)) : addMonths(from, k * months)),
    days: months * 30.44,
    yearBefore: (at) => addMonths(at, -12),
  };
}

/** Cents that add up to the total's cents: each payment the step in the rounded running total, so cents spread evenly. */
function splitCents(total: number, shares: number[]): number[] {
  const scale = shares.reduce((sum, share) => sum + share, 0);
  let running = 0;
  let previous = 0;
  return shares.map((share) => {
    running += share;
    const cents = Math.round((running / scale) * total * 100);
    const amount = (cents - previous) / 100;
    previous = cents;
    return amount;
  });
}

/**
 * The next year of payments: the holding's spacing stepped on from its last payday, the first step on or after `from`
 * (so one due since `from` and not yet paid is still expected), kept before `until`. The year's amount at `quantity` is
 * shared out as the payday a year before each one was, where there was one, so a small interim and a large final
 * dividend stay so, and as the average payday otherwise; the year's payments add up to it to the cent.
 */
export function expectedPayments(schedule: DividendSchedule, quantity: number, from: number, until = Number.POSITIVE_INFINITY): ExpectedPayment[] {
  const annual = Math.round(schedule.annualPerShare * quantity * 100) / 100;
  if (!(annual > 0)) return [];
  const count = schedule.frequency ?? 1;
  const { step, days, yearBefore } = stepper(schedule.payments[schedule.payments.length - 1]!.at, schedule.frequency ?? 1, schedule.monthEnd === true);
  let first = 1;
  while (step(first) < from) first++;
  const dates = Array.from({ length: count }, (_, index) => step(first + index));
  const average = schedule.payments.reduce((total, item) => total + item.perShare, 0) / schedule.payments.length;
  const weights = dates.map((at) => {
    const before = yearBefore(at);
    let match: PaidDividend | undefined;
    for (const item of schedule.payments) {
      const distance = Math.abs(dayStart(item.at) - before);
      if (distance <= (days / 2) * DAY && (!match || distance < Math.abs(dayStart(match.at) - before))) match = item;
    }
    return match?.perShare ?? average;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const amounts = splitCents(annual, weights.map((weight) => (annual * weight) / total));
  return dates.flatMap((at, index) => (at < until && amounts[index]! > 0 ? [{ at, amount: amounts[index]! }] : []));
}
