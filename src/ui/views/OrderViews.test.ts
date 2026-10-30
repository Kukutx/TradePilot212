import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderDraft } from "../../shared/contracts";
import { createTranslator } from "../i18n";
import { OrderEditor } from "./OrderViews";

const draft: OrderDraft = { environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "limit", quantity: 1.5, limitPrice: 230 };
const render = (locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(OrderEditor, {
  draft, locale, t: createTranslator(locale), busy: false, onChange: () => {}, onClose: () => {}, onReview: () => {},
}));

describe("the order form", () => {
  it("shows the side and the type as rows of choices named by their labels, the chosen one the only Tab stop", () => {
    const html = render();
    const side = /<label for="([^"]+)" id="\1-label">Side<\/label>/.exec(html)?.[1];
    expect(side).toBeTruthy();
    expect(html).toContain(`<div class="segmented formChoices" role="radiogroup" aria-labelledby="${side}-label" id="${side}">`);
    expect(html).toContain('<button type="button" role="radio" aria-checked="true" tabindex="0" class="active choice-sell">Sell</button>');
    expect(html).toContain('<button type="button" role="radio" aria-checked="false" tabindex="-1" class=" choice-market">Market</button>');
    expect(html).toContain('aria-checked="true" tabindex="0" class="active choice-limit">Limit</button>');
    expect(html).not.toContain("<select");
  });

  it("types amounts as text, so a wheel or an arrow key does not change them, with the decimal keypad", () => {
    const html = render("zh-CN");
    expect(html).not.toContain('type="number"');
    expect(html.match(/inputMode="decimal"|inputmode="decimal"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
