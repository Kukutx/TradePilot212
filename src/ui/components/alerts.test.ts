import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { AlertForm, alertValueProblem, defaultAlertValue } from "./alerts";

describe("alert form", () => {
  it("starts a price alert 5% either side of the last price, and a percent alert at a common level", () => {
    expect(defaultAlertValue("below", 128.75)).toBe("122.31");
    expect(defaultAlertValue("above", 128.75)).toBe("135.19");
    expect(defaultAlertValue("below", undefined)).toBe("");
    expect(defaultAlertValue("trailing_drop", 128.75)).toBe("8");
    expect(defaultAlertValue("loss_percent", undefined)).toBe("10");
    expect(defaultAlertValue("gain_percent", undefined)).toBe("20");
    expect(defaultAlertValue("day_move", 128.75)).toBe("5");
  });

  it("offers the day's move for any instrument, and the cost-based conditions only for a holding", () => {
    const options = (held: boolean) => [...renderToStaticMarkup(createElement(AlertForm, { held, last: 100, currency: "USD", t: createTranslator("en"), busy: false, onSave: () => {}, onCancel: () => {} }))
      .matchAll(/<option value="([a-z_]+)"/g)].map((match) => match[1]);
    expect(options(false)).toEqual(["below", "above", "day_move"]);
    expect(options(true)).toEqual(["below", "above", "day_move", "trailing_drop", "loss_percent", "gain_percent"]);
  });

  it("checks the value the way the server does", () => {
    expect(alertValueProblem("below", "")).toBe("required");
    expect(alertValueProblem("below", "abc")).toBe("required");
    expect(alertValueProblem("above", "0")).toBe("required");
    expect(alertValueProblem("above", "212,5")).toBeUndefined();
    expect(alertValueProblem("trailing_drop", "100")).toBe("range");
    expect(alertValueProblem("loss_percent", "99.5")).toBeUndefined();
    // A gain can be more than 100%; a price can be any positive number.
    expect(alertValueProblem("gain_percent", "150")).toBeUndefined();
    expect(alertValueProblem("gain_percent", "10000")).toBe("range");
    expect(alertValueProblem("above", "1500")).toBeUndefined();
    expect(alertValueProblem("day_move", "100")).toBe("range");
    expect(alertValueProblem("day_move", "3.5")).toBeUndefined();
  });
});
