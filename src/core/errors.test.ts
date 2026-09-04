import { describe, expect, it } from "vitest";
import { asStructuredError, TradePilotError } from "./errors.js";

describe("structured errors", () => {
  it("preserves explicit error codes and details", () => {
    const result = asStructuredError(new TradePilotError(
      "INSUFFICIENT_CASH",
      "Not enough available cash",
      { requested: 120, available: 80, currency: "EUR" },
    ));

    expect(result).toEqual({
      code: "INSUFFICIENT_CASH",
      message: "Not enough available cash",
      details: { requested: 120, available: 80, currency: "EUR" },
    });
  });

  it("maps legacy broker/service messages to stable codes", () => {
    expect(asStructuredError(new Error("Sell quantity 2 exceeds available quantity 1")).code)
      .toBe("INSUFFICIENT_SELLABLE_QUANTITY");
    expect(asStructuredError(new Error("No Trading 212 instrument matched Example Corp")).code)
      .toBe("INSTRUMENT_NOT_FOUND");
    expect(asStructuredError(new Error("Execution status is unknown; verify before retrying")).code)
      .toBe("EXECUTION_STATUS_UNKNOWN");
  });
});
