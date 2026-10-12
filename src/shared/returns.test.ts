import { describe, expect, it } from "vitest";
import { calendarReturns } from "./returns";

describe("calendar returns", () => {
  // Recording began on 16 April and runs to 12 October: growth 1, then 1.1 at the end of April, 1.21 at the end of
  // May, 1.1 in mid-June (no reading at the end of June), 1.155 on 2 July, 1.2 on 12 October.
  const series = [
    { date: "2026-04-16", return: 0 }, { date: "2026-04-30", return: 0.1 },
    { date: "2026-05-15", return: 0.15 }, { date: "2026-05-31", return: 0.21 },
    { date: "2026-06-14", return: 0.1 },
    { date: "2026-07-02", return: 0.155 },
    { date: "2026-10-12", return: 0.2 },
  ];

  it("chains each month from the last recorded day before it, and marks the ones only partly recorded", () => {
    expect(calendarReturns(series, "month")).toEqual([
      // Began on the 16th: partial.
      { period: "2026-04", return: 0.1, from: "2026-04-16", to: "2026-04-30", partial: true },
      { period: "2026-05", return: 0.1, from: "2026-04-30", to: "2026-05-31" },
      // Its last reading is the 14th: partial.
      { period: "2026-06", return: -0.090909, from: "2026-05-31", to: "2026-06-14", partial: true },
      { period: "2026-07", return: 0.05, from: "2026-06-14", to: "2026-07-02", partial: true },
      // No reading in August or September: October runs from 2 July, and the months between have none.
      { period: "2026-10", return: 0.038961, from: "2026-07-02", to: "2026-10-12", partial: true },
    ]);
  });

  it("gives each year the same way", () => {
    expect(calendarReturns([...series, { date: "2027-01-04", return: 0.32 }], "year")).toEqual([
      { period: "2026", return: 0.2, from: "2026-04-16", to: "2026-10-12", partial: true },
      { period: "2027", return: 0.1, from: "2026-10-12", to: "2027-01-04", partial: true },
    ]);
  });

  it("leaves out a first period with one recorded day, and gives nothing for none", () => {
    expect(calendarReturns([{ date: "2026-04-30", return: 0 }, { date: "2026-05-31", return: 0.05 }], "month")).toEqual([
      { period: "2026-05", return: 0.05, from: "2026-04-30", to: "2026-05-31" },
    ]);
    expect(calendarReturns([], "month")).toEqual([]);
  });
});
