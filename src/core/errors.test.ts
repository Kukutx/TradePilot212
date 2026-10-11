import { describe, expect, it } from "vitest";
import { asStructuredError, TradePilotError } from "./errors.js";
import { ExecutionStatusUnknownError, Trading212ApiError } from "./trading212-client.js";

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

  it("classifies broker errors by their HTTP status, not words in the request path", () => {
    expect(asStructuredError(new Trading212ApiError("Trading 212 POST /equity/orders/limit failed (429)", 429, null))).toMatchObject({ code: "BROKER_RATE_LIMITED", details: { status: 429 } });
    expect(asStructuredError(new Trading212ApiError("Trading 212 GET /equity/account/summary failed (401)", 401, null)).code).toBe("BROKER_REQUEST_FAILED");
    expect(asStructuredError(new Trading212ApiError("Trading 212 DELETE /equity/orders/7 failed (400): {\"code\":\"x\"}", 400, null)).code).toBe("BROKER_REQUEST_FAILED");
    expect(asStructuredError(new ExecutionStatusUnknownError("Trading 212 returned 502 after a write.")).code).toBe("EXECUTION_STATUS_UNKNOWN");
  });
});
