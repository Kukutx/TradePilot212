import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BasketLeg, RebalancePlan } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { basketTotals, BasketView, withDraftReasons, type BasketDraftView } from "./BasketView";

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

describe("rebalance summary", () => {
  it("totals the buys and sells and shows the conversion fee only when there is one", () => {
    const sell: BasketLeg = { draft: { environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "market", quantity: 2, referencePrice: 200 } };
    const buy: BasketLeg = { draft: { environment: "demo", ticker: "EUNLd_EQ", side: "buy", type: "market", quantity: 5, referencePrice: 100 } };
    const plan = (totals: RebalancePlan["totals"]): RebalancePlan => ({
      kind: "rebalance_plan", environment: "demo", accountCurrency: "EUR", totalValue: 10_000, cashBefore: 200, cashAfter: 70,
      trades: [], skipped: [], notes: [], ...(totals ? { totals } : {}),
    });
    const render = (rebalance: RebalancePlan, locale: "en" | "zh-CN" = "en") => renderToStaticMarkup(createElement(BasketView, {
      payload: { kind: "basket_draft", environment: "demo", title: "Rebalance", purpose: "rebalance", legs: [sell, buy], notes: [], rebalance } as unknown as BasketDraftView,
      legs: [sell, buy], preview: null, result: null, verifications: {}, canReview: true, busy: false, locale, t: createTranslator(locale),
      onRemoveLeg: () => {}, onReview: () => {}, onBack: () => {}, onConfirm: () => {}, onClose: () => {}, onVerify: () => {},
    }));
    const html = render(plan({ currency: "EUR", bought: 500, sold: 370, converted: 370, fxFee: 0.56, fxFeeRate: 0.0015 }));
    expect(html).toContain("<span>Buys</span><strong>€500.00</strong>");
    expect(html).toContain("<span>Sells</span><strong>€370.00</strong>");
    expect(html).toContain("<span>FX fee, at most</span><strong>€0.56</strong>");
    expect(render(plan({ currency: "EUR", bought: 500, sold: 370, converted: 370, fxFee: 0.56, fxFeeRate: 0.0015 }), "zh-CN")).toContain("<span>汇兑费（上限）</span>");
    // Nothing converted, or no fee set: no fee row. A plan from before 2.52 has no totals.
    expect(render(plan({ currency: "EUR", bought: 500, sold: 0, converted: 0, fxFee: 0, fxFeeRate: 0.0015 }))).not.toContain("FX fee");
    expect(render(plan({ currency: "EUR", bought: 500, sold: 0, converted: 500, fxFee: 0, fxFeeRate: 0 }))).not.toContain("FX fee");
    expect(render(plan({ currency: "EUR", bought: 500, sold: 0, converted: 0, fxFee: 0, fxFeeRate: 0.0015 }))).not.toContain("<span>Sells</span>");
    expect(render(plan(undefined))).not.toContain("<span>Buys</span>");
  });
});

describe("rebalance totals after a leg is taken out", () => {
  it("adds up the trades left, with the fee on the ones in other currencies, and the cash after them", () => {
    const trade = (ticker: string, side: "buy" | "sell", value: number, currency: string) => ({ ticker, side, quantity: 1, price: value, currency, value, currentWeight: 0, targetWeight: 0, resultingWeight: 0 });
    const trades = [trade("AAPL_US_EQ", "sell", 400, "USD"), trade("EUNLd_EQ", "buy", 500, "EUR"), trade("MSFT_US_EQ", "buy", 300, "USD")];
    const plan: RebalancePlan = {
      kind: "rebalance_plan", environment: "demo", accountCurrency: "EUR", totalValue: 10_000, cashBefore: 600, cashAfter: 198.95, trades, skipped: [], notes: [],
      totals: { currency: "EUR", bought: 800, sold: 400, converted: 700, fxFee: 1.05, fxFeeRate: 0.0015 },
    };
    // All there: the plan's own figures.
    expect(basketTotals(plan, trades)).toEqual({ totals: plan.totals, cashAfter: 198.95 });
    // Without the Microsoft buy: 600 + 400 − 500 − 0.60 of fee on the dollar sell.
    expect(basketTotals(plan, trades.slice(0, 2))).toEqual({ totals: { currency: "EUR", bought: 500, sold: 400, converted: 400, fxFee: 0.6, fxFeeRate: 0.0015 }, cashAfter: 499.4 });
    // A plan from before 2.52 has no totals; its cash after still follows the trades left.
    const { totals: _totals, ...old } = plan;
    expect(basketTotals(old, trades.slice(1, 2))).toEqual({ cashAfter: 100 });
  });
});
