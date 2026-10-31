import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { monthWeeks, pickDay, RangeCalendar, realDay, shiftDay } from "./calendar";

describe("the range calendar", () => {
  it("lays a month out in weeks from Monday", () => {
    const weeks = monthWeeks("2026-10");
    // 1 October 2026 is a Thursday.
    expect(weeks[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(weeks.at(-1)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    // February 2027 starts on a Monday and fills four weeks exactly.
    expect(monthWeeks("2027-02")).toHaveLength(4);
  });

  it("moves by days across months and by months to the last day the month has", () => {
    expect(shiftDay("2026-10-31", { days: 1 })).toBe("2026-11-01");
    expect(shiftDay("2026-03-01", { days: -1 })).toBe("2026-02-28");
    expect(shiftDay("2026-01-31", { months: 1 })).toBe("2026-02-28");
    expect(shiftDay("2024-03-31", { months: -1 })).toBe("2024-02-29");
    expect(shiftDay("2026-10-15", { months: -12 })).toBe("2025-10-15");
  });

  it("starts a range on the first press and ends it on the next, unless that is before the first", () => {
    expect(pickDay({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-05")).toEqual({ from: "2026-10-05", to: "" });
    expect(pickDay({ from: "2026-10-05", to: "" }, "2026-10-20")).toEqual({ from: "2026-10-05", to: "2026-10-20" });
    expect(pickDay({ from: "2026-10-05", to: "" }, "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(pickDay({ from: "2026-10-05", to: "" }, "2026-10-01")).toEqual({ from: "2026-10-01", to: "" });
  });

  it("takes only days on the calendar", () => {
    expect(realDay("2026-02-28")).toBe(true);
    expect(realDay("2024-02-29")).toBe(true);
    expect(realDay("2026-02-31")).toBe(false);
    expect(realDay("2026-13-01")).toBe(false);
    expect(realDay("2026-1-01")).toBe(false);
    expect(realDay("")).toBe(false);
  });

  it("draws the month of the range with its ends, the days between and today, and no days after today", () => {
    const html = renderToStaticMarkup(createElement(RangeCalendar, { from: "2026-10-05", to: "2026-10-07", min: "2000-01-01", max: "2026-10-30", today: "2026-10-30", locale: "en", t: createTranslator("en"), onPick: () => {} }));
    expect(html).toContain('role="grid" aria-label="October 2026"');
    expect(html).toContain('<th scope="col" abbr="Monday">M</th>');
    expect(html).toContain('<td role="gridcell" aria-selected="true" class="start"><button type="button" data-day="2026-10-05" tabindex="-1" aria-label="Monday, October 5, 2026">5</button></td>');
    expect(html).toContain('<td role="gridcell" aria-selected="true" class="inside">');
    // The Tab stop is the range's last day.
    expect(html).toContain('data-day="2026-10-07" tabindex="0"');
    expect(html).toContain('class="today"><button type="button" data-day="2026-10-30" tabindex="-1" aria-label="Friday, October 30, 2026" aria-current="date">30</button>');
    expect(html).toContain('data-day="2026-10-31" tabindex="-1" disabled=""');
    // Next month is past today.
    expect(html).toMatch(/aria-label="Next month" title="Next month" disabled=""/);
  });
});
