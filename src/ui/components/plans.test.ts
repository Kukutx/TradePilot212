import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DcaPlan } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { planChanges, planDraft, PlanForm, PlanList, planProblems, planRequest } from "./plans";

const en = createTranslator("en");
const noop = () => {};
const plan: DcaPlan = {
  id: "dca_1", environment: "demo", label: "Monthly core", frequency: "monthly", dayOfMonth: 5, hourUtc: 15, autoExecute: false, paused: false,
  legs: [{ ticker: "VUSAl_EQ", amount: 1250 }, { ticker: "MSFT_US_EQ", amount: 100, orderType: "limit", limitOffsetPercent: 0.5 }],
  nextRunAt: "2026-11-05T15:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z",
};

describe("investment plans in the widget", () => {
  it("starts the form from the plan, its amounts as plain figures, and saves the same plan back unchanged", () => {
    const draft = planDraft(plan);
    expect(draft.legs.map((leg) => leg.amount)).toEqual(["1250", "100"]);
    const request = planRequest(draft, "demo");
    expect(request).toEqual({ label: "Monthly core", legs: plan.legs, frequency: "monthly", dayOfMonth: 5, hourUtc: 15, autoExecute: false });
    // Nothing changed is nothing sent: a schedule sent again would start the plan again from now.
    expect(planChanges(plan, request)).toEqual({});
  });

  it("sends only what changed, the whole schedule when any of it did", () => {
    const draft = { ...planDraft(plan), frequency: "weekly" as const, weekday: 3 };
    expect(planChanges(plan, planRequest(draft, "demo"))).toEqual({ frequency: "weekly", weekday: 3, hourUtc: 15 });
    const renamed = { ...planDraft(plan), label: "Core", legs: [{ ticker: "VUSAl_EQ", amount: "300" }] };
    expect(planChanges(plan, planRequest(renamed, "demo"))).toEqual({ label: "Core", legs: [{ ticker: "VUSAl_EQ", amount: 300 }] });
  });

  it("never sends unattended running for a Live plan, and invests by targets with an amount", () => {
    const draft = { ...planDraft(undefined), mode: "targets" as const, targetAmount: "500", autoExecute: true };
    expect(planRequest(draft, "live")).toEqual({ label: "", targetAmount: 500, frequency: "monthly", dayOfMonth: 1, hourUtc: 15 });
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
    const managed = renderToStaticMarkup(createElement(PlanList, { ...props, onSave: async () => true, onChange: async () => true, onDelete: noop, onReview: noop }));
    expect(managed).toContain('data-reveals="form">New plan</button>');
    for (const label of ["Open orders now", "Pause", "Change", "Delete"]) expect(managed).toContain(`>${label}</button>`);
    expect(managed).toContain("Monthly on day 5 · 15:00 UTC");
    expect(renderToStaticMarkup(createElement(PlanList, { ...props, plans: [{ ...plan, paused: true }], onSave: async () => true, onChange: async () => true, onDelete: noop, onReview: noop }))).toContain(">Resume</button>");
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
});
