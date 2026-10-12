import { describe, expect, it } from "vitest";
import { addMonths, dividendSchedule, expectedPayments, monthStart, scheduleStart } from "./dividends.js";

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const paid = (day: string, perShare: number) => ({ at: Date.parse(`${day}T14:30:00Z`), perShare });

describe("dividend schedule", () => {
  it("steps months on the same day, or the month's last where it is shorter", () => {
    expect(iso(addMonths(at("2027-01-31"), 1))).toBe("2027-02-28");
    expect(iso(addMonths(at("2028-01-31"), 1))).toBe("2028-02-29");
    expect(iso(addMonths(at("2026-12-15"), 3))).toBe("2027-03-15");
    expect(iso(addMonths(at("2026-03-31"), -1))).toBe("2026-02-28");
    expect(iso(addMonths(Date.parse("2026-10-12T09:00:00Z"), 12))).toBe("2027-10-12");
    expect(iso(monthStart(Date.parse("2026-10-12T09:00:00Z")))).toBe("2026-10-01");
    expect(iso(scheduleStart(Date.parse("2026-10-12T09:00:00Z")))).toBe("2025-10-01");
  });

  it("joins payments days apart into one, and reads the frequency from the spacing", () => {
    // Two entries two days apart: one payment for the spacing, its amounts per share added.
    const schedule = dividendSchedule([paid("2025-12-01", 0.3), paid("2025-12-02", 0.2), paid("2026-03-01", 0.5), paid("2026-06-01", 0.5), paid("2026-09-01", 0.5)]);
    expect(schedule?.payments).toHaveLength(4);
    expect(schedule?.payments[0]?.perShare).toBeCloseTo(0.5, 9);
    expect(schedule?.frequency).toBe(4);
    expect(schedule?.annualPerShare).toBeCloseTo(2, 9);
    expect(dividendSchedule([])).toBeUndefined();
    expect(dividendSchedule([paid("2026-05-01", 1)])).toEqual({ payments: [paid("2026-05-01", 1)], annualPerShare: 1 });
  });

  it("expects a year of a quarterly payer's payments, a quarter apart from its last", () => {
    const schedule = dividendSchedule([paid("2025-12-01", 0.5), paid("2026-03-01", 0.5), paid("2026-06-01", 0.5), paid("2026-09-01", 0.5)])!;
    const from = at("2026-10-01");
    expect(expectedPayments(schedule, 10, from, addMonths(from, 12)).map((payment) => [iso(payment.at), payment.amount])).toEqual([
      ["2026-12-01", 5], ["2027-03-01", 5], ["2027-06-01", 5], ["2027-09-01", 5],
    ]);
  });

  it("keeps a small interim and a large final dividend at their own sizes", () => {
    const schedule = dividendSchedule([paid("2025-10-20", 0.6), paid("2026-04-20", 0.2)])!;
    expect(schedule.frequency).toBe(2);
    const from = at("2026-10-01");
    // The final is due this month and not paid yet, so it is still expected.
    expect(expectedPayments(schedule, 100, from, addMonths(from, 12)).map((payment) => [iso(payment.at), payment.amount])).toEqual([
      ["2026-10-20", 60], ["2027-04-20", 20],
    ]);
  });

  it("fills in the payments before a holding was bought at the average, so the year still adds up", () => {
    // Bought in May: June's and September's payments, so a year of a quarterly payer has two more.
    const schedule = dividendSchedule([paid("2026-06-01", 0.4), paid("2026-09-01", 0.6)])!;
    expect(schedule.annualPerShare).toBeCloseTo(2, 9);
    const from = at("2026-10-01");
    const payments = expectedPayments(schedule, 10, from, addMonths(from, 12));
    expect(payments.map((payment) => [iso(payment.at), payment.amount])).toEqual([
      ["2026-12-01", 5], ["2027-03-01", 5], ["2027-06-01", 4], ["2027-09-01", 6],
    ]);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(20);
  });

  it("reads one payment made on parts of a holding as one, and a correction as part of the payday before it", () => {
    // 5 shares and 10 shares paid 0.20 each on the same day: 0.20 a share, not 0.40.
    const split = dividendSchedule([
      { at: at("2026-03-01"), perShare: 0.2, amount: 1, quantity: 5 }, { at: at("2026-03-01"), perShare: 0.2, amount: 2, quantity: 10 },
      { at: at("2026-06-01"), perShare: 0.2, amount: 3, quantity: 15 },
    ])!;
    expect(split.payments.map((payment) => payment.perShare)).toEqual([0.2, 0.2]);
    // A special dividend beside the regular one, on the same shares, adds up.
    expect(dividendSchedule([{ at: at("2026-03-01"), perShare: 0.2, amount: 2, quantity: 10 }, { at: at("2026-03-02"), perShare: 1, amount: 10, quantity: 10 }])!.payments[0]!.perShare).toBeCloseTo(1.2, 9);
    // A correction weeks later takes from the payday before it rather than being a payday of its own.
    const corrected = dividendSchedule([paid("2025-11-01", 0.5), paid("2025-11-20", -0.1), paid("2026-02-01", 0.5), paid("2026-05-01", 0.5), paid("2026-08-01", 0.5)])!;
    expect(corrected.frequency).toBe(4);
    expect(corrected.payments).toHaveLength(4);
    expect(corrected.annualPerShare).toBeCloseTo(1.9, 9);
    const payments = expectedPayments(corrected, 10, at("2026-11-01"), addMonths(at("2026-11-01"), 12));
    expect(payments.every((payment) => payment.amount > 0)).toBe(true);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0)).toBeCloseTo(19, 9);
    // A payment reversed in full leaves nothing.
    expect(dividendSchedule([paid("2026-05-01", 0.5), paid("2026-05-20", -0.5)])).toBeUndefined();
  });

  it("calls a holding weekly only when its paydays bear it out, and otherwise keeps entries days apart in one payday", () => {
    // Bought last month: a regular dividend and a special one a week later are one payday, not a weekly payer.
    const pair = dividendSchedule([{ at: at("2026-09-01"), perShare: 0.5, amount: 5, quantity: 10 }, { at: at("2026-09-08"), perShare: 1, amount: 10, quantity: 10 }])!;
    expect(pair.frequency).toBeUndefined();
    expect(pair.annualPerShare * 10).toBeCloseTo(15, 9);
    // A quarterly payer with a second, smaller entry five days after each payday.
    const quarterly = dividendSchedule(["2025-11-03", "2026-02-02", "2026-05-04", "2026-08-03"].flatMap((day) => [
      { at: at(day), perShare: 0.4, amount: 4, quantity: 10 }, { at: at(day) + 5 * 86_400_000, perShare: 0.1, amount: 1, quantity: 10 },
    ]))!;
    expect(quarterly.frequency).toBe(4);
    expect(quarterly.annualPerShare * 10).toBeCloseTo(20, 9);
    // A monthly payer with an adjustment six days after each payday.
    const monthly = dividendSchedule(Array.from({ length: 12 }, (_, index) => addMonths(at("2025-10-15"), index)).flatMap((day) => [
      { at: day, perShare: 0.1, amount: 1, quantity: 10 }, { at: day + 6 * 86_400_000, perShare: 0.01, amount: 0.1, quantity: 10 },
    ]))!;
    expect(monthly.frequency).toBe(12);
    expect(monthly.annualPerShare * 10).toBeCloseTo(13.2, 9);
  });

  it("takes only the newest year's paydays, where the year read holds one payment twice", () => {
    const schedule = dividendSchedule(["2025-10-02", "2026-01-02", "2026-04-01", "2026-07-01", "2026-10-01"].map((day) => paid(day, 0.5)))!;
    expect(schedule.frequency).toBe(4);
    expect(schedule.annualPerShare).toBeCloseTo(2, 9);
  });

  it("follows weekly payers week by week, and month-end payers to each month's end", () => {
    const weekly = dividendSchedule(Array.from({ length: 13 }, (_, index) => ({ at: at("2026-07-03") + index * 7 * 86_400_000, perShare: 0.1 })))!;
    expect(weekly.frequency).toBe(52);
    expect(weekly.annualPerShare).toBeCloseTo(5.2, 9);
    const weeks = expectedPayments(weekly, 10, at("2026-10-01"));
    expect(weeks).toHaveLength(52);
    expect(weeks.slice(0, 2).map((payment) => [iso(payment.at), payment.amount])).toEqual([["2026-10-02", 1], ["2026-10-09", 1]]);
    const monthEnd = dividendSchedule([paid("2026-07-31", 0.1), paid("2026-08-31", 0.1), paid("2026-09-30", 0.1)])!;
    expect(expectedPayments(monthEnd, 10, at("2026-10-01")).slice(0, 3).map((payment) => iso(payment.at))).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    // Paying on the 30th lands on some month ends, but is not a month-end payer.
    const thirtieth = dividendSchedule([paid("2026-06-30", 0.1), paid("2026-07-30", 0.1), paid("2026-08-30", 0.1), paid("2026-09-30", 0.1)])!;
    expect(expectedPayments(thirtieth, 10, at("2026-10-01")).slice(0, 2).map((payment) => iso(payment.at))).toEqual(["2026-10-30", "2026-11-30"]);
  });

  it("shares the year out to the cent", () => {
    const monthly = dividendSchedule(["2026-07-15", "2026-08-15", "2026-09-15"].map((day) => paid(day, 1 / 3)))!;
    const payments = expectedPayments(monthly, 10, at("2026-10-01"));
    expect(payments).toHaveLength(12);
    expect(Math.round(payments.reduce((sum, payment) => sum + payment.amount, 0) * 100)).toBe(4000);
    expect(new Set(payments.map((payment) => payment.amount))).toEqual(new Set([3.33, 3.34]));
    // Cents too few for every payment spread over the year rather than bunching at its start.
    const weekly = dividendSchedule(Array.from({ length: 8 }, (_, index) => ({ at: at("2026-08-07") + index * 7 * 86_400_000, perShare: 0.0005 })))!;
    const small = expectedPayments(weekly, 10, at("2026-10-01"));
    expect(small).toHaveLength(26);
    expect(iso(small[small.length - 1]!.at) > "2027-09-01").toBe(true);
  });

  it("does not expect a yearly payment again within the year it was paid this month", () => {
    const schedule = dividendSchedule([paid("2026-10-03", 1.2)])!;
    const from = at("2026-10-01");
    expect(expectedPayments(schedule, 10, from, addMonths(from, 12))).toEqual([]);
    // Paid last October, it is expected this October.
    expect(expectedPayments(dividendSchedule([paid("2025-10-03", 1.2)])!, 10, at("2026-09-01"), addMonths(at("2026-09-01"), 12)).map((payment) => [iso(payment.at), payment.amount])).toEqual([["2026-10-03", 12]]);
    expect(expectedPayments(schedule, 0, from, addMonths(from, 12))).toEqual([]);
  });
});
