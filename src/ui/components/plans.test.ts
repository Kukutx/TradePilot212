import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DcaPlan } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { defaultHour, planChanges, planDraft, PlanForm, PlanList, planProblems, planRequest, planSchedule, sameInstrument } from "./plans";

const en = createTranslator("en");
const noop = () => {};
const plan: DcaPlan = {
  id: "dca_1", environment: "demo", label: "Monthly core", frequency: "monthly", dayOfMonth: 5, hour: 15, timeZone: "UTC", autoExecute: false, paused: false,
  legs: [{ ticker: "VUSAl_EQ", amount: 1250 }, { ticker: "MSFT_US_EQ", amount: 100, orderType: "limit", limitOffsetPercent: 0.5 }],
  nextRunAt: "2026-11-05T15:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z",
};

describe("investment plans in the widget", () => {
  it("starts the form from the plan, its amounts as plain figures, and saves the same plan back unchanged", () => {
    const draft = planDraft(plan, "Europe/London");
    expect(draft.legs.map((leg) => leg.amount)).toEqual(["1250", "100"]);
    const request = planRequest(draft, "demo");
    expect(request).toEqual({ label: "Monthly core", legs: plan.legs, frequency: "monthly", dayOfMonth: 5, hour: 15, timeZone: "UTC", autoExecute: false });
    // Nothing changed is nothing sent: a schedule sent again would start the plan again from now.
    expect(planChanges(plan, request)).toEqual({});
  });

  it("sends only what changed, the whole schedule when any of it did", () => {
    const draft = { ...planDraft(plan), frequency: "weekly" as const, weekday: 3 };
    expect(planChanges(plan, planRequest(draft, "demo"))).toEqual({ frequency: "weekly", weekday: 3, hour: 15, timeZone: "UTC" });
    const daily = { ...planDraft(plan), frequency: "daily" as const, timeZone: "Europe/London" };
    expect(planChanges(plan, planRequest(daily, "demo"))).toEqual({ frequency: "daily", hour: 15, timeZone: "Europe/London" });
    const renamed = { ...planDraft(plan), label: "Core", legs: [{ ticker: "VUSAl_EQ", amount: "300" }] };
    expect(planChanges(plan, planRequest(renamed, "demo"))).toEqual({ label: "Core", legs: [{ ticker: "VUSAl_EQ", amount: 300 }] });
  });

  it("never sends unattended running for a Live plan, and invests by targets with an amount", () => {
    const draft = { ...planDraft(undefined, "UTC"), mode: "targets" as const, targetAmount: "500", autoExecute: true };
    expect(planRequest(draft, "live")).toEqual({ targetAmount: 500, frequency: "monthly", dayOfMonth: 1, hour: 15, timeZone: "UTC" });
  });

  it("starts a new plan in the server's zone at the hour that is 15:00 UTC there", () => {
    const summer = new Date("2026-07-01T00:00:00Z");
    expect(defaultHour("Europe/London", summer)).toBe(16);
    expect(defaultHour("Asia/Shanghai", summer)).toBe(23);
    expect(planDraft(undefined, "Europe/Berlin")).toMatchObject({ timeZone: "Europe/Berlin" });
  });

  it("says each schedule in words, with its hour and zone", () => {
    const at = { hour: 9, timeZone: "Europe/London" };
    expect(planSchedule({ frequency: "daily", ...at }, en, "en")).toBe("Every weekday · 09:00 Europe/London");
    expect(planSchedule({ frequency: "biweekly", weekday: 3, ...at }, en, "en")).toBe("Every other Wednesday · 09:00 Europe/London");
    expect(planSchedule({ frequency: "monthly", dayOfMonth: 31, ...at }, en, "en")).toBe("Monthly on the last day · 09:00 Europe/London");
    expect(planSchedule({ frequency: "monthly", dayOfMonth: 30, ...at }, en, "en")).toBe("Monthly on day 30 (or the month's last day) · 09:00 Europe/London");
  });

  it("asks for an instrument and an amount above zero on each buy", () => {
    const draft = { ...planDraft(undefined), legs: [{ ticker: "", amount: "0" }, { ticker: "NVDA", amount: "1,250" }, { ticker: "VUSA", amount: "50" }] };
    expect(planProblems(draft).legs).toEqual([{ ticker: true, amount: true }, { amount: true }, {}]);
    expect(planProblems({ ...draft, mode: "targets", targetAmount: "" }).targetAmount).toBe(true);
  });

  it("offers the plan's actions only where the account can be written to", () => {
    const props = { plans: [plan], environment: "demo" as const, currency: "EUR", hasTargets: false, locale: "en" as const, t: en, busy: false };
    const readOnly = renderToStaticMarkup(createElement(PlanList, props));
    expect(readOnly).not.toContain("New plan");
    expect(readOnly).not.toContain("Open orders now");
    const managed = renderToStaticMarkup(createElement(PlanList, { ...props, onSave: async () => true as const, onChange: async () => true as const, onSkip: noop, onDelete: noop, onReview: noop }));
    expect(managed).toContain('data-reveals="form">New plan</button>');
    // Busy, the buttons stay focusable rather than disabled, so focus stays on the one pressed.
    expect(renderToStaticMarkup(createElement(PlanList, { ...props, busy: true, onSave: async () => true as const, onChange: async () => true as const, onSkip: noop, onDelete: noop, onReview: noop }))).not.toContain("disabled=\"\"");
    for (const label of ["Open orders now", "Skip next", "Pause", "Change", "Delete"]) expect(managed).toContain(`>${label}</button>`);
    expect(managed).toContain("Monthly on day 5 · 15:00 UTC");
    expect(renderToStaticMarkup(createElement(PlanList, { ...props, plans: [{ ...plan, paused: true }], onSave: async () => true as const, onChange: async () => true as const, onSkip: noop, onDelete: noop, onReview: noop }))).toContain(">Resume</button>");
  });

  it("draws the form with the widget's own lists and switches, and the Demo-only unattended switch", () => {
    const html = (environment: "demo" | "live") => renderToStaticMarkup(createElement(PlanForm, { plan, environment, currency: "EUR", hasTargets: true, locale: "en", t: en, busy: false, onSave: noop, onCancel: noop }));
    expect(html("demo")).toContain('role="radiogroup"');
    expect(html("demo")).toContain('role="combobox"');
    expect(html("demo")).not.toContain("<select");
    expect(html("demo")).toMatch(/Limit buy, up to 0\.50?% above the last price/);
    expect(html("demo")).toContain("Run unattended when due (Demo)");
    expect(html("live")).not.toContain("Run unattended");
  });

  it("keeps a leg's ticker and limit while it still names the same instrument, however typed", () => {
    const book = { MSFT_US_EQ: { name: "Microsoft", shortName: "MSFT" } };
    expect(sameInstrument(" msft ", "MSFT_US_EQ")).toBe(true);
    expect(sameInstrument("VUSA", "VUSAl_EQ")).toBe(true);
    expect(sameInstrument("Microsoft", "MSFT_US_EQ", book)).toBe(false);
    const draft = planDraft(plan);
    const retyped = { ...draft, legs: [draft.legs[0]!, { ...draft.legs[1]!, ticker: "msft" }] };
    expect(planRequest(retyped, "demo", book).legs).toEqual(plan.legs);
    expect(planChanges(plan, planRequest(retyped, "demo", book))).toEqual({});
    const other = { ...draft, legs: [draft.legs[0]!, { ...draft.legs[1]!, ticker: "AAPL" }] };
    expect(planRequest(other, "demo").legs?.[1]).toEqual({ ticker: "AAPL", amount: 100 });
  });

  it("names each amount by its buy, and says why a save failed inside the form", () => {
    const html = (extra: object) => renderToStaticMarkup(createElement(PlanForm, { plan, environment: "demo", currency: "EUR", hasTargets: false, locale: "en", t: en, busy: false, onSave: noop, onCancel: noop, ...extra }));
    expect(html({})).toContain('aria-label="Amount for instrument 2"');
    expect(html({})).toContain('aria-label="Remove instrument 2 (MSFT_US_EQ)"');
    expect(html({ error: "No matching instrument" })).toMatch(/role="alert".*No matching instrument/);
  });
});
