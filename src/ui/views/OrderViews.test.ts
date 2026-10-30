import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderDraft } from "../../shared/contracts";
import { createTranslator } from "../i18n";
import { OrderEditor, syncedText } from "./OrderViews";

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

  it("keeps what is typed while it reads as the draft's amount, so typing 1,234 is not rewritten half way", () => {
    // "1,2" sets 1.2; the field keeps "1,2" rather than turning it into "1.2", so the next keys make "1,234".
    expect(syncedText("1,2", 1.2)).toBe("1,2");
    expect(syncedText("1,234", 1234)).toBe("1,234");
    expect(syncedText("0,5", 0.5)).toBe("0,5");
    // A value set from elsewhere (the calculated quantity restored) replaces the text.
    expect(syncedText("1,2", 3)).toBe("3");
    expect(syncedText("", undefined)).toBe("");
  });

  it("adds no reading hint under an amount typed as a plain number", () => {
    const view = (quantity: number) => renderToStaticMarkup(createElement(OrderEditor, { draft: { ...draft, quantity }, locale: "en", t: createTranslator("en"), busy: false, onChange: () => {}, onClose: () => {}, onReview: () => {} }));
    expect(view(1.5)).not.toContain("Read as");
  });
});
