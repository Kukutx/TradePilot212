import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IncomeSummary } from "../../shared/history";
import { createTranslator } from "../i18n";
import { DividendCalendar } from "./dividend-calendar";

type Forward = NonNullable<IncomeSummary["forwardAnnual"]>;

const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09"];
const forward = (upcoming: Forward["upcoming"], paid = 0): Forward => ({
  total: 100,
  byTicker: [],
  yieldOnValue: 0.02,
  calendar: months.map((month, index) => ({
    month,
    paid: index === 0 ? paid : 0,
    expected: upcoming.filter((payment) => payment.on.startsWith(month)).reduce((sum, payment) => sum + payment.amount, 0),
  })),
  upcoming,
});
const book = { KO_US_EQ: { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO" } };
const render = (data: Forward, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(DividendCalendar, {
  forward: data, today: "2026-10-12T09:00:00Z", currency: "EUR", book, locale, t: createTranslator(locale),
}));

describe("dividend calendar", () => {
  it("stacks what was paid this month under what is expected, labels the largest month, and lists the payments soonest first", () => {
    const html = render(forward([
      { ticker: "KO_US_EQ", on: "2026-10-01", amount: 12.13 },
      { ticker: "MSFT_US_EQ", on: "2026-12-11", amount: 4.24 },
      { ticker: "KO_US_EQ", on: "2027-01-01", amount: 12.13 },
    ], 8.5));
    expect(html.match(/class="column"/g)).toHaveLength(12);
    // October: paid and expected, both in one column, the paid part at the bottom.
    expect(html).toContain('title="October 2026: €8.50 paid, about €12.13 more expected"><span class="columnValue">€20.63</span><span class="calendarStack" style="height:100%"><span class="calendarExpected" style="flex-grow:12.13"></span><span class="calendarPaid" style="flex-grow:8.5"></span></span>');
    expect(html).toContain('title="December 2026: about €4.24 expected"><span class="columnValue"></span><span class="calendarStack" style="height:20.6%">');
    // A month with nothing has no bar.
    expect(html).toContain('title="February 2027: nothing expected"><span class="columnValue"></span><span class="columnLabel">Feb</span>');
    expect(html).toContain('<p class="calendarLegend"><span class="calendarRange">Oct 2026 to Sep 2027</span><span><i class="calendarPaid" aria-hidden="true"></i>Paid this month</span><span><i class="calendarExpected" aria-hidden="true"></i>Expected: about €28.50</span>');
    // Due this month and not paid yet; the rest in date order, the year shown once it turns.
    expect(html).toMatch(/<li><div><strong title="KO_US_EQ">Coca-Cola<\/strong><small>KO · due around Oct 1, not paid yet<\/small><\/div><strong class="historyAmount expectedAmount">≈ €12\.13<\/strong><\/li><li><div><strong title="MSFT_US_EQ">MSFT<\/strong><small>around Dec 11<\/small>/);
    expect(html).toContain("<small>KO · around Jan 1, 2027</small>");
    expect(html).not.toContain("Show all");
  });

  it("lists eight payments until asked for all, and says when nothing is expected, in Chinese", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ ticker: "KO_US_EQ", on: `${months[index + 1]}-15`, amount: 3 }));
    const html = render(forward(many), "zh-CN");
    expect(html.match(/<li>/g)).toHaveLength(8);
    expect(html).toContain('<button type="button" class="linkButton" aria-expanded="false">显示全部 11 笔</button>');
    expect(html).toContain("分红日历 · 未来 12 个月");
    expect(html).not.toContain("本月已到账");
    expect(html).toContain("<small>KO · 约 11月15日</small>");
    expect(html).toContain('<span class="calendarRange">2026年10月 至 2027年9月</span>');
    expect(html).toContain('<span class="columnLabel">10月</span>');
    expect(render(forward([]), "zh-CN")).toContain("暂无预计分红：近 12 个月没有持仓派过息。");
  });
});
