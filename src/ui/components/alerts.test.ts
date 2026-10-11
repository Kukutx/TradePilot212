import { describe, expect, it } from "vitest";
import { alertValueProblem, defaultAlertValue } from "./alerts";

describe("alert form", () => {
  it("starts a price alert 5% either side of the last price, and a percent alert at a common level", () => {
    expect(defaultAlertValue("below", 128.75)).toBe("122.31");
    expect(defaultAlertValue("above", 128.75)).toBe("135.19");
    expect(defaultAlertValue("below", undefined)).toBe("");
    expect(defaultAlertValue("trailing_drop", 128.75)).toBe("8");
    expect(defaultAlertValue("loss_percent", undefined)).toBe("10");
    expect(defaultAlertValue("gain_percent", undefined)).toBe("20");
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
  });
});
