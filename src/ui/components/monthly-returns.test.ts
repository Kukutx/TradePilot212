import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CalendarReturn } from "../../shared/history";
import { createTranslator } from "../i18n";
import { MonthlyReturns } from "./monthly-returns";

const months: CalendarReturn[] = [
  { period: "2025-12", return: 0.012, from: "2025-12-10", to: "2025-12-31", partial: true },
  { period: "2026-01", return: -0.034, from: "2025-12-31", to: "2026-01-31" },
  { period: "2026-02", return: 0.05, from: "2026-01-31", to: "2026-02-28" },
  // No reading at the end of March: April reaches back to 20 March.
  { period: "2026-04", return: 0.02, from: "2026-03-20", to: "2026-04-30", extended: true },
];
const years: CalendarReturn[] = [
  { period: "2025", return: 0.012, from: "2025-12-10", to: "2025-12-31", partial: true },
  { period: "2026", return: 0.0143, from: "2025-12-31", to: "2026-02-28", partial: true },
];
const render = (locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(MonthlyReturns, { months, years, locale, t: createTranslator(locale) }));

describe("monthly returns", () => {
  it("puts each month in its year's row, latest year first, with the year's return at the end", () => {
    const html = render();
    expect(html.indexOf("<th scope=\"row\">2026</th>")).toBeLessThan(html.indexOf("<th scope=\"row\">2025</th>"));
    // Tinted by size against the scale's end (5%, which covers four in five months): 3.4% of it is 0.68.
    expect(html).toContain('<td class="monthlyCell down" style="--tile-strength:0.680" title="January 2026: -3.40%, from Dec 31, 2025 to Jan 31, 2026">');
    expect(html).toContain('<td class="monthlyCell up" style="--tile-strength:1.000" title="February 2026: +5.00%, from Jan 31, 2026 to Feb 28, 2026"><span aria-hidden="true">+5.0%</span>');
    // Partly recorded: marked and said.
    expect(html).toContain('class="monthlyCell up partial"');
    expect(html).toContain("December 2025: +1.20%, from Dec 10, 2025 to Dec 31, 2025, only part of the month");
    // Reaching back over days not recorded: marked the same way, its days said.
    expect(html).toContain('class="monthlyCell up partial" style="--tile-strength:0.400" title="April 2026: +2.00%, from Mar 20, 2026, the last recorded day before it, to Apr 30, 2026"');
    expect(html).toContain('class="monthlyCell monthlyTotal up partial"');
    // A month without a reading is empty, and says so to a screen reader.
    expect(html).toContain('<td class="monthlyCell empty"><span class="visuallyHidden">No recorded days</span></td>');
    expect(html).toContain("Not the exact month");
    // The row headers' column and the year's return are named apart.
    expect(html).toContain('<th scope="col"><span class="visuallyHidden">Year</span></th>');
    expect(html).toContain('<th scope="col" class="monthlyTotal">Full year</th>');
  });

  it("gives narrow screens each year as a grid of months, in Chinese", () => {
    const html = render("zh-CN");
    expect(html).toContain('<div class="monthlyCompact">');
    expect(html).toContain("<h3>2026<span class=\"monthlyYearTotal up partial\"");
    expect(html).toContain("<small aria-hidden=\"true\">2月</small><span aria-hidden=\"true\">+5.0%</span>");
    expect(html).toContain("3月：没有记录");
    expect(html).toContain("月度收益");
  });
});
