import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BasketLeg } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { BasketView, withDraftReasons, type BasketDraftView } from "./BasketView";

const leg = (ticker: string, side: "buy" | "sell", reason?: string): BasketLeg => ({
  draft: { environment: "demo", ticker, side, type: "stop", quantity: 1, stopPrice: 10 },
  ...(reason ? { reason } : {}),
});

describe("basket confirmation", () => {
  it("keeps each draft leg's reason after the review reorders the legs", () => {
    const drafts = [leg("AAPL_US_EQ", "sell", "Matches the existing stop"), leg("KO_US_EQ", "sell", "8% below the last price")];
    const reviewed = withDraftReasons([leg("KO_US_EQ", "sell"), leg("AAPL_US_EQ", "sell"), leg("MSFT_US_EQ", "sell")], drafts);
    expect(reviewed.map((item) => item.reason)).toEqual(["8% below the last price", "Matches the existing stop", undefined]);
    // A reason the review itself gives stays.
    expect(withDraftReasons([leg("KO_US_EQ", "sell", "own")], drafts)[0]!.reason).toBe("own");
  });
});

describe("basket header", () => {
  it("labels the basket by the legs still in it", () => {
    const stop: BasketLeg = { draft: { environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "stop", quantity: 5, stopPrice: 180, timeValidity: "GOOD_TILL_CANCEL" } };
    const take: BasketLeg = { draft: { environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "limit", quantity: 5, limitPrice: 250, timeValidity: "GOOD_TILL_CANCEL" } };
    const payload = { kind: "basket_draft", environment: "demo", title: "Protect AAPL_US_EQ", purpose: "protective", legs: [stop, take], notes: [] } as unknown as BasketDraftView;
    const render = (legs: BasketLeg[]) => renderToStaticMarkup(createElement(BasketView, {
      payload, legs, preview: null, result: null, verifications: {}, canReview: true, busy: false, locale: "en", t: createTranslator("en"),
      onRemoveLeg: () => {}, onReview: () => {}, onBack: () => {}, onConfirm: () => {}, onClose: () => {}, onVerify: () => {},
    }));
    expect(render([stop, take])).toContain(">Stop-loss / take-profit<");
    // With the take-profit removed, only the stop-loss is left.
    expect(render([stop])).toContain('class="purposeTag">Stop-loss<');
  });
});
