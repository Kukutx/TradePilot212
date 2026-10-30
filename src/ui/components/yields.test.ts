import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { CashPanel, YieldPanel } from "./yields";

const t = createTranslator("en");

describe("the Income tab's yields and cash", () => {
  it("sets yield on cost beside yield on value, per holding with what it paid and is expected to pay", () => {
    const html = renderToStaticMarkup(createElement(YieldPanel, { currency: "EUR", locale: "en", t, book: { KO_US_EQ: { name: "Coca-Cola", shortName: "KO" } }, data: {
      paid: 30, trailing: 20, forward: 24, cost: 1000, value: 1000, onCost: 0.02, onValue: 0.02, forwardOnCost: 0.024,
      byTicker: [{ ticker: "KO_US_EQ", paid: 30, trailing: 20, forward: 24, cost: 400, value: 500, onCost: 0.05, onValue: 0.04, forwardOnCost: 0.06 }],
    } }));
    expect(html).toContain("Dividend yield");
    expect(html).toContain("<span>Yield on cost, last 12 months</span><strong>2.00%</strong>");
    // What was actually paid sits beside the yields, which are of the shares held now.
    expect(html).toContain("<td>5.00%</td><td>4.00%</td><td>€30.00</td>");
    expect(html).toContain('<td title="KO_US_EQ"><strong>Coca-Cola</strong><small>KO · expected €24.00</small></td>');
    expect(html).toMatch(/<table class="chartTable yieldTable" aria-labelledby="[^"]+">/);
    // Without every holding's cost the account's yield on cost is not given.
    expect(renderToStaticMarkup(createElement(YieldPanel, { currency: "EUR", locale: "en", t, data: { paid: 20, trailing: 20, forward: 0, cost: null, value: 1000, onCost: null, onValue: 0.02, forwardOnCost: null, byTicker: [] } })))
      .toContain('<span>Yield on cost, last 12 months</span><strong><span aria-hidden="true">—</span><span class="visuallyHidden">not known</span></strong>');
  });

  it("gives the cash not invested with its parts, its share and the interest it earned", () => {
    const cash = { total: 325, available: 300, inPies: 20, reserved: 5, share: 0.25, interest12Months: 6, lending12Months: 4, rate: { yearly: 0.0365, averageCash: 1000, since: "2026-08-02", days: 60 } };
    const html = renderToStaticMarkup(createElement(CashPanel, { currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN"), data: cash }));
    expect(html).toContain("未投资的现金");
    expect(html).toContain("25.0%");
    expect(html).toContain("3.65%");
    expect(html).toContain("近 12 个月股票借出收入");
    expect(html).toMatch(/可交易 €300\.00/);
    // Until a month of days is recorded there is no rate, and the panel says why.
    const none = renderToStaticMarkup(createElement(CashPanel, { currency: "EUR", locale: "en", t, data: { ...cash, lending12Months: 0, rate: null } }));
    expect(none).toContain("The rate needs a month of days");
    expect(none).not.toContain("Share lending");
  });
});
