import type { StructuredError, TradePilotErrorCode } from "../shared/contracts.js";
import { ExecutionStatusUnknownError, Trading212ApiError } from "./trading212-client.js";

export type ErrorDetails = Record<string, string | number | boolean | null>;

export class TradePilotError extends Error {
  constructor(
    readonly code: TradePilotErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "TradePilotError";
  }
}

function inferredCode(message: string): TradePilotErrorCode {
  if (/credentials? (?:are |is )?not configured/i.test(message)) return "CREDENTIALS_NOT_CONFIGURED";
  if (/no Trading 212 instrument matched/i.test(message)) return "INSTRUMENT_NOT_FOUND";
  if (/\bambiguous\b/i.test(message)) return "INSTRUMENT_AMBIGUOUS";
  if (/no tradable .* position|no available position/i.test(message)) return "NO_AVAILABLE_POSITION";
  if (/no available cash/i.test(message)) return "NO_AVAILABLE_CASH";
  if (/exceeds available quantity|currently tradable/i.test(message)) return "INSUFFICIENT_SELLABLE_QUANTITY";
  if (/exceeds available cash/i.test(message)) return "INSUFFICIENT_CASH";
  if (/referencePrice is required|reference price is required/i.test(message)) return "REFERENCE_PRICE_REQUIRED";
  if (/MAX_ORDER_NOTIONAL|notional .* exceeds/i.test(message)) return "ORDER_NOTIONAL_LIMIT";
  if (/MAX_ORDER_QUANTITY|maxOpenQuantity/i.test(message)) return "ORDER_QUANTITY_LIMIT";
  if (/extendedHours|extended-hours/i.test(message)) return "UNSUPPORTED_EXTENDED_HOURS";
  if (/confirmation .* invalid or expired|confirmation token is invalid or expired/i.test(message)) return "CONFIRMATION_EXPIRED";
  if (/verification .* missing or expired/i.test(message)) return "VERIFICATION_NOT_FOUND";
  if (/\b429\b|rate limit/i.test(message)) return "BROKER_RATE_LIMITED";
  if (/Trading 212 .* failed/i.test(message)) return "BROKER_REQUEST_FAILED";
  if (/status is unknown|execution status is unknown|write status is unknown/i.test(message)) return "EXECUTION_STATUS_UNKNOWN";
  if (/required|must be|only valid|cannot exceed|too small/i.test(message)) return "INVALID_INPUT";
  return "INTERNAL_ERROR";
}

/** A broker rejection: the wording names the rule when Trading 212 gives one, otherwise it is a failed request. */
function inferredBrokerCode(message: string): TradePilotErrorCode {
  const code = inferredCode(message.replace(/\/equity\/[^\s)]*/g, ""));
  return code === "INTERNAL_ERROR" || code === "INVALID_INPUT" || code === "BROKER_RATE_LIMITED" ? "BROKER_REQUEST_FAILED" : code;
}

export function asStructuredError(error: unknown): StructuredError {
  if (error instanceof TradePilotError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  // Broker errors carry their HTTP status, which says more than any wording in the message.
  if (error instanceof ExecutionStatusUnknownError) return { code: "EXECUTION_STATUS_UNKNOWN", message };
  if (error instanceof Trading212ApiError) {
    const code = error.status === 429 ? "BROKER_RATE_LIMITED" : error.status === 401 || error.status === 403 ? "BROKER_REQUEST_FAILED" : inferredBrokerCode(message);
    return { code, message, details: { status: error.status } };
  }
  return { code: inferredCode(message), message };
}

export function fail(
  code: TradePilotErrorCode,
  message: string,
  details?: ErrorDetails,
): never {
  throw new TradePilotError(code, message, details);
}
