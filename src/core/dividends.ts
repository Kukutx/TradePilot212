// When dividends come: each holding's usual spacing between payments, read from its payments of the last year, and
// the payments that spacing implies at the current quantity. Pure functions; the clock is passed in.

const DAY = 86_400_000;
/** Entries this close together are one payday. */
const SAME_PAYDAY_DAYS = 3;

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

/** A holding's schedule from its payments since `scheduleStart`; none without a payday that paid. */
export function dividendSchedule(paid: PaidDividend[]): DividendSchedule | undefined {
  const groups: PaidDividend[][] = [];
  for (const item of [...paid].filter((entry) => Number.isFinite(entry.at) && Number.isFinite(entry.perShare)).sort((a, b) => a.at - b.at)) {
    const group = groups[groups.length - 1];
    if (group && item.at - group[group.length - 1]!.at <= SAME_PAYDAY_DAYS * DAY) group.push(item);
    else groups.push([item]);
  }
  // A correction on its own (zero or less) belongs to the payday before it, not a payday of its own.
  const days: PaidDividend[] = [];
  for (const group of groups) {
    const perShare = paydayPerShare(group);
    if (perShare > 0) days.push({ at: group[0]!.at, perShare });
    else if (days.length) days[days.length - 1]!.perShare += perShare;
  }
  const payments = days.filter((day) => day.perShare > 0);
  if (!payments.length) return undefined;
  const gaps = payments.slice(1).map((item, index) => (item.at - payments[index]!.at) / DAY).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : undefined;
  const frequency: DividendFrequency | undefined = gap === undefined ? undefined
    : gap < 10 ? 52 : gap < 21 ? 26 : gap < 45 ? 12 : gap < 135 ? 4 : gap < 270 ? 2 : 1;
  // The newest year's paydays: a schedule read over a little more than a year can hold one payment twice.
  const count = frequency ?? 1;
  const recent = payments.slice(-count);
  const sum = recent.reduce((total, item) => total + item.perShare, 0);
  return { payments, ...(frequency ? { frequency } : {}), annualPerShare: recent.length < count ? (sum * count) / recent.length : sum };
}

/** The `k`th payday after `last` at the schedule's spacing; a holding that pays on a month's last day keeps to it. */
function stepper(last: number, frequency: DividendFrequency): { step: (k: number) => number; days: number; yearBefore: (at: number) => number } {
  const from = dayStart(last);
  if (frequency >= 26) {
    const days = 364 / frequency;
    return { step: (k) => from + k * days * DAY, days, yearBefore: (at) => at - 364 * DAY };
  }
  const months = 12 / frequency;
  const atMonthEnd = monthEnd(from) === from;
  return {
    step: (k) => (atMonthEnd ? monthEnd(addMonths(monthStart(from), k * months)) : addMonths(from, k * months)),
    days: months * 30.44,
    yearBefore: (at) => addMonths(at, -12),
  };
}

/** Cents that add up to the total's cents: each share rounded down, the cents left to the largest remainders. */
function splitCents(total: number, shares: number[]): number[] {
  const cents = shares.map((share) => Math.floor(share * 100 + 1e-9));
  let left = Math.round(total * 100) - cents.reduce((sum, value) => sum + value, 0);
  const order = shares.map((share, index) => ({ index, rest: share * 100 - cents[index]! })).sort((a, b) => b.rest - a.rest);
  for (const { index } of order) {
    if (left <= 0) break;
    cents[index] = cents[index]! + 1;
    left -= 1;
  }
  return cents.map((value) => value / 100);
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
  const { step, days, yearBefore } = stepper(schedule.payments[schedule.payments.length - 1]!.at, schedule.frequency ?? 1);
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
