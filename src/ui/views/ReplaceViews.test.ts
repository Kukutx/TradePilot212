import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingOrder, ReplacePreview } from "../../shared/contracts";
import { createTranslator } from "../i18n";
import { changeBlock } from "../lib/orders";
import { changesFrom, openOrderTerms, replaceReasonText, ReplaceConfirmation, ReplaceEditor } from "./ReplaceViews";

const limitBuy: PendingOrder = { id: 81234, ticker: "TSLA_US_EQ", side: "BUY", quantity: 3, filledQuantity: 0, status: "NEW", type: "LIMIT", limitPrice: 215, timeInForce: "GOOD_TILL_CANCEL", strategy: "QUANTITY" };
const stopSell: PendingOrder = { id: 81235, ticker: "NVDA_US_EQ", side: "SELL", quantity: -5, filledQuantity: 0, status: "NEW", type: "STOP", stopPrice: 118, timeInForce: "DAY" };
const en = createTranslator("en");
const zh = createTranslator("zh-CN");

describe("the change of an open order", () => {
  it("reads the order's own figures and sends only what the form changed", () => {
    expect(openOrderTerms(stopSell)).toMatchObject({ side: "sell", quantity: 5, stopPrice: 118, timeValidity: "DAY", needsLimit: false, needsStop: true });
    expect(changesFrom(limitBuy, { quantity: "3", limitPrice: "215", stopPrice: "", timeValidity: "GOOD_TILL_CANCEL" })).toEqual({ changes: {}, invalid: [] });
    expect(changesFrom(limitBuy, { quantity: "4", limitPrice: "212,5", stopPrice: "", timeValidity: "DAY" })).toEqual({ changes: { quantity: 4, limitPrice: 212.5, timeValidity: "DAY" }, invalid: [] });
    // A stop has no limit to read; an empty or unreadable figure is an error, not a change.
    expect(changesFrom(stopSell, { quantity: "", limitPrice: "x", stopPrice: "1,234", timeValidity: "DAY" }).invalid).toEqual(["quantity", "stopPrice"]);
  });

  it("offers the change only for an order it can change", () => {
    expect(changeBlock(limitBuy)).toBeUndefined();
    expect(changeBlock({ ...limitBuy, type: "MARKET" })).toBe("market");
    expect(changeBlock({ ...limitBuy, strategy: "VALUE" })).toBe("value");
    expect(changeBlock({ ...limitBuy, filledQuantity: 1 })).toBe("partly_filled");
  });

  it("starts the editor from the change proposed and says how a change is made", () => {
    const html = renderToStaticMarkup(createElement(ReplaceEditor, { environment: "demo", order: limitBuy, initial: { limitPrice: 210 }, locale: "zh-CN", t: zh, busy: false, onClose: () => {}, onReview: () => {} }));
    expect(html).toContain('value="210"');
    expect(html).toContain("Trading 212 不能直接改单");
    expect(html).toContain("检查改单");
  });

  it("shows the order as it is beside the one that replaces it, with the changed rows marked in words", () => {
    const preview: ReplacePreview = {
      kind: "replace_preview", token: "t".repeat(24), expiresAt: "2026-10-31T12:00:00Z", snapshotAt: "2026-10-31T11:55:00Z", environment: "live", orderId: "81234", original: limitBuy,
      draft: { environment: "live", ticker: "TSLA_US_EQ", side: "buy", type: "limit", quantity: 3, limitPrice: 210, timeValidity: "GOOD_TILL_CANCEL" },
      instrument: { ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "USD" }, estimatedNotional: 630, estimatedNotionalCurrency: "USD", notices: [],
    };
    const html = renderToStaticMarkup(createElement(ReplaceConfirmation, { preview, locale: "en", t: en, busy: false, onBack: () => {}, onConfirm: () => {} }));
    expect(html).toContain("Change LIVE order?");
    expect(html.match(/class="changed"/g)).toHaveLength(1);
    expect(html).toMatch(/<td>\$215\.00<\/td><td>\$210\.00<span class="changeBadge">Changed<\/span>/);
    // Live: the confirm button waits for the second confirmation.
    expect(html).toMatch(/<button type="button" class="dangerButton" disabled="">Confirm LIVE change<\/button>/);
    expect(replaceReasonText("not_confirmed", zh)).toMatch(/还没显示原单没有成交/);
    expect(replaceReasonText("other", zh)).toBeUndefined();
  });
});
