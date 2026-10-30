import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { CashPanel, YieldPanel } from "./yields";

const t = createTranslator("en");

describe("the Income tab's yields and cash", () => {
  it("sets yield on cost beside yield on value, per holding with what it paid and is expected to pay", () => {
    const html = renderToStaticMarkup(createElement(YieldPanel, { currency: "EUR", locale: "en", t, data: {
      trailing: 20, forward: 24, cost: 1000, value: 1000, onCost: 0.02, onValue: 0.02, forwardOnCost: 0.024,
      byTicker: [{ ticker: "KO_US_EQ", trailing: 20, forward: 24, cost: 400, value: 500, onCost: 0.05, onValue: 0.04, forwardOnCost: 0.06 }],
    } }));
    expect(html).toContain("Dividend yield");
    expect(html).toContain("<span>Yield on cost</span><strong>2.00%</strong>");
    expect(html).toContain("<td>5.00%</td><td>4.00%</td><td>€20.00</td>");
    expect(html).toContain("<small>€24.00 expected next 12 months</small>");
    // Without every holding's cost the account's yield on cost is not given.
    expect(renderToStaticMarkup(createElement(YieldPanel, { currency: "EUR", locale: "en", t, data: { trailing: 20, forward: 0, cost: null, value: 1000, onCost: null, onValue: 0.02, forwardOnCost: null, byTicker: [] } })))
      .toContain("<span>Yield on cost</span><strong>—</strong>");
  });

  it("gives the cash not invested, its share and the interest it earned", () => {
    const html = renderToStaticMarkup(createElement(CashPanel, { currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN"), data: { available: 300, share: 0.2308, interest12Months: 6, rateOnToday: 0.02 } }));
    expect(html).toContain("未投资的现金");
    expect(html).toContain("23.1%");
    expect(html).toContain("2.00%");
  });
});
