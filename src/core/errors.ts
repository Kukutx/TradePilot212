import type { StructuredError, TradePilotErrorCode } from "../shared/contracts.js";

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
  if (/MAX_ORDER_NOTIONAL|notional .* exceeds/i.test(message)) return "ORDER_NOTIONAL_LIMIT";
  if (/MAX_ORDER_QUANTITY|maxOpenQuantity/i.test(message)) return "ORDER_QUANTITY_LIMIT";
  if (/referencePrice is required|reference price is required/i.test(message)) return "REFERENCE_PRICE_REQUIRED";
  if (/extendedHours|extended-hours/i.test(message)) return "UNSUPPORTED_EXTENDED_HOURS";
  if (/confirmation .* invalid or expired|confirmation token is invalid or expired/i.test(message)) return "CONFIRMATION_EXPIRED";
  if (/verification .* missing or expired/i.test(message)) return "VERIFICATION_NOT_FOUND";
  if (/429|rate limit/i.test(message)) return "BROKER_RATE_LIMITED";
  if (/Trading 212 .* failed/i.test(message)) return "BROKER_REQUEST_FAILED";
  if (/status is unknown|execution status is unknown|write status is unknown/i.test(message)) return "EXECUTION_STATUS_UNKNOWN";
  if (/required|must be|only valid|cannot exceed|too small/i.test(message)) return "INVALID_INPUT";
  return "INTERNAL_ERROR";
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
  return { code: inferredCode(message), message };
}

export function fail(
  code: TradePilotErrorCode,
  message: string,
  details?: ErrorDetails,
): never {
  throw new TradePilotError(code, message, details);
}
