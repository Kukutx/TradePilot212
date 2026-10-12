// When dividends come: each holding's usual spacing between payments, read from the last year's payments, and the
// payments that spacing implies at the current quantity. Pure functions; the clock is passed in.

const DAY = 86_400_000;
/** Payments closer than this count as one for the spacing and the year's count, their amounts per share added. */
const SAME_PAYMENT_DAYS = 10;

/** One payment, per share: net of withholding tax and in the account currency, as Trading 212 pays it. */
export interface PaidDividend { at: number; perShare: number }

export interface DividendSchedule {
  /** The payments of the last year, oldest first, with payments days apart joined into one (amounts per share added). */
  payments: PaidDividend[];
  /** Payments a year, from their median spacing; none from a single payment. */
  frequency?: 12 | 4 | 2 | 1;
  /** A year's payments per share: those seen, scaled up to the frequency for a holding bought during the year. */
  annualPerShare: number;
}

/** An expected payment: when, about, and how much at the current quantity, in the account currency. */
export interface ExpectedPayment { at: number; amount: number }

const round = (value: number) => Math.round(value * 100) / 100;

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

/** A holding's schedule from its payments in the last year; none without a payment. */
export function dividendSchedule(paid: PaidDividend[]): DividendSchedule | undefined {
  const payments: PaidDividend[] = [];
  for (const item of [...paid].filter((entry) => Number.isFinite(entry.at) && Number.isFinite(entry.perShare)).sort((a, b) => a.at - b.at)) {
    const previous = payments[payments.length - 1];
    if (previous && item.at - previous.at <= SAME_PAYMENT_DAYS * DAY) previous.perShare += item.perShare;
    else payments.push({ ...item });
  }
  if (!payments.length) return undefined;
  const sum = payments.reduce((total, item) => total + item.perShare, 0);
  const gaps = payments.slice(1).map((item, index) => (item.at - payments[index]!.at) / DAY).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : undefined;
  const frequency = gap === undefined ? undefined : gap < 45 ? 12 : gap < 135 ? 4 : gap < 270 ? 2 : 1;
  return {
    payments,
    ...(frequency ? { frequency } : {}),
    annualPerShare: frequency && payments.length < frequency ? (sum * frequency) / payments.length : sum,
  };
}

/**
 * A year of payments from `from`: the holding's spacing stepped on from its last payment, the first step on or after
 * `from` (so one due since `from` and not yet paid is still expected), up to `until`. Each payment is its share of the
 * year's amount at `quantity`: as large as the payment a year before it, where there was one, so a small interim and a
 * large final dividend stay so; as large as the average payment otherwise.
 */
export function expectedPayments(schedule: DividendSchedule, quantity: number, from: number, until: number): ExpectedPayment[] {
  const annual = schedule.annualPerShare * quantity;
  if (!(annual > 0)) return [];
  const count = schedule.frequency ?? 1;
  const step = 12 / count;
  const last = schedule.payments[schedule.payments.length - 1]!.at;
  let first = 1;
  while (addMonths(last, first * step) < from) first++;
  const dates = Array.from({ length: count }, (_, index) => addMonths(last, (first + index) * step));
  const average = schedule.payments.reduce((total, item) => total + item.perShare, 0) / schedule.payments.length;
  const halfStep = step * 15 * DAY;
  const weights = dates.map((at) => {
    const yearBefore = addMonths(at, -12);
    let match: PaidDividend | undefined;
    for (const item of schedule.payments) {
      if (Math.abs(item.at - yearBefore) <= halfStep && (!match || Math.abs(item.at - yearBefore) < Math.abs(match.at - yearBefore))) match = item;
    }
    return Math.max(0, match?.perShare ?? average);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return dates.flatMap((at, index) => (at < until ? [{ at, amount: round(total > 0 ? (annual * weights[index]!) / total : annual / count) }] : []));
}
