import { describe, expect, it } from "vitest";
import { addMonths, dividendSchedule, expectedPayments, monthStart } from "./dividends.js";

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

  it("does not expect a yearly payment again within the year it was paid this month", () => {
    const schedule = dividendSchedule([paid("2026-10-03", 1.2)])!;
    const from = at("2026-10-01");
    expect(expectedPayments(schedule, 10, from, addMonths(from, 12))).toEqual([]);
    // Paid last October, it is expected this October.
    expect(expectedPayments(dividendSchedule([paid("2025-10-03", 1.2)])!, 10, at("2026-09-01"), addMonths(at("2026-09-01"), 12)).map((payment) => [iso(payment.at), payment.amount])).toEqual([["2026-10-03", 12]]);
    expect(expectedPayments(schedule, 0, from, addMonths(from, 12))).toEqual([]);
  });
});
