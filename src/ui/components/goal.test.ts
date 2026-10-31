import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectGoal, type InvestmentGoal } from "../../shared/goal";
import { createTranslator } from "../i18n";
import { defaultGoal, GoalChart, GoalPanel, GoalProgressLine, monthEnd } from "./goal";

const t = createTranslator("en");
const now = new Date("2026-10-31T12:00:00Z");
const goal: InvestmentGoal = {
  environment: "demo", target: 100_000, by: "2036-12-31", monthly: 500, expectedReturn: 0.06, volatility: 0.15, name: "Retirement",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};
const resolve = async () => undefined;

describe("the investment goal panel", () => {
  it("dates a goal at the end of the month chosen", () => {
    expect(monthEnd(2030, 2)).toBe("2030-02-28");
    expect(monthEnd(2032, 2)).toBe("2032-02-29");
    expect(monthEnd(2030, 12)).toBe("2030-12-31");
  });

  it("starts the form at about twice the value now, rounded, ten years out", () => {
    expect(defaultGoal(23_456, now)).toMatchObject({ target: 50_000, by: "2036-10-31", monthly: 200, expectedReturn: 0.06, volatility: 0.15 });
    // An empty account still gets a goal to start from.
    expect(defaultGoal(undefined, now).target).toBe(1_000);
  });

  it("offers to set a goal when there is none", () => {
    const html = renderToStaticMarkup(createElement(GoalPanel, { value: 20_000, currency: "EUR", locale: "en", t, busy: false, onSave: resolve, onRemove: async () => true }));
    expect(html).toContain("Investment goal");
    expect(html).toContain("Set a goal");
    expect(html).not.toContain("progressbar");
  });

  it("shows the progress, the chance and the range of a saved goal, saying it is not a forecast", () => {
    const html = renderToStaticMarkup(createElement(GoalPanel, { goal, value: 25_000, currency: "EUR", locale: "en", t, busy: false, onSave: resolve, onRemove: async () => true }));
    expect(html).toContain("Goal · Retirement");
    expect(html).toContain('role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25"');
    expect(html).toContain("Chance of reaching it");
    expect(html).toContain("Likely range");
    expect(html).toContain("not a forecast");
    expect(html).toContain("€500 a month");
  });

  it("says when the account value is not known instead of measuring against nothing", () => {
    const html = renderToStaticMarkup(createElement(GoalPanel, { goal, currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN"), busy: false, onSave: resolve, onRemove: async () => true }));
    expect(html).toContain("没能读到账户市值");
    expect(html).not.toContain("progressbar");
  });

  it("draws the band, the middle line, what is added and the target, with a legend naming each", () => {
    const projection = projectGoal(goal, 25_000, now);
    const html = renderToStaticMarkup(createElement(GoalChart, { projection, target: goal.target, currency: "EUR", locale: "en", t }));
    expect(html).toContain('class="goalBand"');
    expect(html).toContain('class="linePath"');
    expect(html).toContain('class="lineCompare"');
    expect(html).toContain('class="goalTarget"');
    expect(html).toContain("Target €100,000");
    for (const name of ["Middle", "Likely range", "Added, no growth", "Target"]) expect(html).toContain(`</svg>${name}</li>`.replace("</svg>Likely range", "</span>Likely range"));
  });

  it("puts the goal's share of the target under the dashboard's value, opening the goal when it can", () => {
    const html = renderToStaticMarkup(createElement(GoalProgressLine, { goal, value: 25_000, currency: "EUR", locale: "en", t, onOpen: () => {} }));
    expect(html).toContain('<button type="button" class="goalLine" aria-label="Retirement: 25.0% of €100,000 by Dec 31, 2036. Open the goal">');
    expect(html).toContain("<b>Retirement</b> 25.0% of €100,000");
    expect(html).toContain('style="width:25.0%"');
    // Without a way to open it, it is not a button; without the value, there is no line.
    expect(renderToStaticMarkup(createElement(GoalProgressLine, { goal, value: 25_000, currency: "EUR", locale: "zh-CN", t: createTranslator("zh-CN") }))).toContain('<div class="goalLine" role="group"');
    expect(renderToStaticMarkup(createElement(GoalProgressLine, { goal, currency: "EUR", locale: "en", t }))).toBe("");
  });
});
