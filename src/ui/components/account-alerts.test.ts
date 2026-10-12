import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountAlert } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { parseAmount } from "../lib/format";
import { AccountAlertForm, AccountAlertList, accountAlertProblem, defaultAccountAlertValue } from "./account-alerts";

const alerts: AccountAlert[] = [
  { id: "a1", environment: "demo", condition: "value_below", amount: 9000, currency: "GBP", createdAt: "2026-10-01T00:00:00Z", lastValue: 10250.5, lastCheckedAt: "2026-10-12T10:00:00Z" },
  { id: "a2", environment: "demo", condition: "day_move", percent: 3, currency: "GBP", createdAt: "2026-10-01T00:00:00Z", lastValue: -0.0312, lastDay: "2026-10-12", triggeredAt: "2026-10-12T15:00:00Z", triggeredValue: -0.0312, triggeredDay: "2026-10-12", note: "Check the stops." },
];
const noop = () => undefined;

describe("typed amounts", () => {
  it("reads either separator, and a lone comma before three digits as thousands", () => {
    expect(parseAmount("10,000")).toBe(10_000);
    expect(parseAmount("1,250.5")).toBe(1_250.5);
    expect(parseAmount("1.250,5")).toBe(1_250.5);
    expect(parseAmount("1.000.000")).toBe(1_000_000);
    expect(parseAmount(" 10 000 ")).toBe(10_000);
    expect(parseAmount("12\u00a0500,75")).toBe(12_500.75);
    expect(parseAmount("250,5")).toBe(250.5);
    expect(parseAmount("0,125")).toBe(0.125);
    expect(parseAmount("1.250")).toBe(1.25);
    expect(parseAmount(".5")).toBe(0.5);
    expect(parseAmount("-3")).toBe(-3);
    for (const text of ["", ",", "1,2,3", "1.000,000.5", "12,34,567", "1e3", "abc"]) expect(parseAmount(text)).toBeNaN();
  });
});

describe("account alerts", () => {
  it("lists what each alert watches, its last reading and when it fired", () => {
    const html = renderToStaticMarkup(createElement(AccountAlertList, { alerts, currency: "GBP", now: { value: 10250, cash: 800 }, locale: "en", t: createTranslator("en"), busy: false, onSave: async () => true, onDelete: noop, onRearm: noop }));
    expect(html).toContain("<h2>Account alerts</h2>");
    expect(html).toContain("<strong>Account value at or below £9,000.00</strong>");
    expect(html).toContain("<small>Last read £10,250.50</small>");
    expect(html).toContain("<strong>Account&#x27;s day move either way of 3%</strong>");
    expect(html).toContain("-3.12% on Oct 12");
    expect(html).toContain("Armed again on the next trading day");
    expect(html).toContain("Check the stops.");
    // A day's move arms itself again: no re-arm button; both can be deleted.
    expect(html).not.toContain("Re-arm");
    expect(html.match(/>Delete</g)).toHaveLength(2);
    expect(html).toContain(">Add alert<");
  });

  it("says what one does when there are none, in Chinese", () => {
    const html = renderToStaticMarkup(createElement(AccountAlertList, { alerts: [], now: {}, locale: "zh-CN", t: createTranslator("zh-CN"), busy: false }));
    expect(html).toContain("账户提醒");
    expect(html).toContain("还没有账户提醒");
    // Without a way to save, no button.
    expect(html).not.toContain("添加提醒");
  });

  it("starts the form from the account now and checks the amount", () => {
    expect(defaultAccountAlertValue("value_below", { value: 10_250 })).toBe("9740");
    expect(defaultAccountAlertValue("value_above", { value: 10_250 })).toBe("10760");
    expect(defaultAccountAlertValue("cash_above", { cash: 30 })).toBe("100");
    expect(defaultAccountAlertValue("cash_below", { cash: 800 })).toBe("400");
    expect(defaultAccountAlertValue("day_move", {})).toBe("2");
    expect(accountAlertProblem("value_above", "0")).toBe("required");
    expect(accountAlertProblem("day_move", "100")).toBe("range");
    expect(accountAlertProblem("cash_below", "250,5")).toBeUndefined();
    expect(accountAlertProblem("value_below", "10,000")).toBeUndefined();
    expect(accountAlertProblem("day_move", "1,5")).toBeUndefined();
    expect(accountAlertProblem("value_below", "10,00,0")).toBe("required");
    const form = renderToStaticMarkup(createElement(AccountAlertForm, { currency: "GBP", now: { value: 10_250 }, t: createTranslator("en"), busy: false, onSave: noop, onCancel: noop }));
    expect(form).toContain('value="9740"');
    expect(form).toContain("GBP");
    expect(form).toContain("every ten minutes");
  });
});
