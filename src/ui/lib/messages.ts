import type { PolicyCheck } from "../../shared/automation";
import type { ActivityEvent, ExecutionVerificationResult, Instrument, OrderNotice, OrderSizing, StructuredError } from "../../shared/contracts";
import type { MessageKey, SupportedLocale } from "../i18n";
import { dateTime, num } from "./format";

export type Translator = (key: MessageKey) => string;

export function formatProblem(problem: StructuredError, t: Translator, locale: SupportedLocale): string {
  const details = problem.details ?? {};
  const number = (key: string) => typeof details[key] === "number" ? num(details[key] as number, locale) : String(details[key] ?? "—");
  switch (problem.code) {
    case "CREDENTIALS_NOT_CONFIGURED": return t("errorCredentials");
    case "INSTRUMENT_NOT_FOUND": return t("errorInstrumentNotFound");
    case "INSTRUMENT_AMBIGUOUS": return details.matches ? `${t("errorInstrumentAmbiguous")} ${details.matches}` : t("errorInstrumentAmbiguous");
    case "NO_AVAILABLE_POSITION": return t("errorNoPosition");
    case "NO_AVAILABLE_CASH": return t("errorNoCash");
    case "INSUFFICIENT_SELLABLE_QUANTITY": return typeof details.requested === "number" && typeof details.available === "number" ? `${t("errorSellable")} ${number("requested")} / ${number("available")}` : t("errorSellable");
    case "INSUFFICIENT_CASH": return typeof details.requested === "number" && typeof details.available === "number" ? `${t("errorCash")} ${number("requested")} / ${number("available")} ${details.currency ?? ""}`.trim() : t("errorCash");
    case "ORDER_NOTIONAL_LIMIT": return typeof details.requested === "number" && typeof details.limit === "number" ? `${t("errorNotionalLimit")} ${number("requested")} / ${number("limit")} ${details.currency ?? ""}`.trim() : t("errorNotionalLimit");
    case "ORDER_QUANTITY_LIMIT": return typeof details.requested === "number" && typeof details.limit === "number" ? `${t("errorQuantityLimit")} ${number("requested")} / ${number("limit")}` : t("errorQuantityLimit");
    case "REFERENCE_PRICE_REQUIRED": return t("errorReferencePrice");
    case "UNSUPPORTED_EXTENDED_HOURS": return t("errorExtendedHours");
    case "CONFIRMATION_EXPIRED": return t("errorConfirmationExpired");
    case "VERIFICATION_NOT_FOUND": return t("errorVerificationMissing");
    case "BROKER_RATE_LIMITED": return t("errorBrokerRateLimit");
    case "BROKER_REQUEST_FAILED": return t("errorBroker");
    case "EXECUTION_STATUS_UNKNOWN": return t("errorUnknownExecution");
    case "POLICY_BLOCKED": return problem.message ? `${t("errorPolicyBlocked")} ${problem.message}` : t("errorPolicyBlocked");
    case "PLAN_NOT_FOUND": return t("errorPlanNotFound");
    case "LIVE_ACK_REQUIRED": return t("errorLiveAckRequired");
    case "INVALID_INPUT": return problem.message;
    default: return problem.message || t("errorInternal");
  }
}

export function noticeText(notice: OrderNotice, t: Translator, locale: SupportedLocale): string {
  switch (notice.code) {
    case "LIVE_FUNDS": return t("liveFundsNotice");
    case "MARKET_SLIPPAGE": return t("marketSlippageNotice");
    case "REFERENCE_PRICE_STALE": {
      const seconds = typeof notice.details?.ageSeconds === "number" ? notice.details.ageSeconds : undefined;
      return seconds === undefined ? t("referenceStaleNotice") : `${t("referenceStaleNotice")} ${num(Math.round(seconds / 60), locale, 0)} min`;
    }
    case "REFERENCE_PRICE_TIME_UNKNOWN": return t("referenceTimeUnknownNotice");
    case "FX_RATE_STALE": {
      const seconds = typeof notice.details?.ageSeconds === "number" ? notice.details.ageSeconds : undefined;
      return seconds === undefined ? t("fxStaleNotice") : `${t("fxStaleNotice")} ${num(Math.round(seconds / 60), locale, 0)} min`;
    }
    case "CROSS_CURRENCY_FUNDS_CHECK": return t("crossCurrencyNotice");
    case "NOTIONAL_ESTIMATE_UNAVAILABLE": return t("notionalUnavailableNotice");
    case "MARKET_CLOSED":
    case "MARKET_CLOSED_QUEUED": {
      const base = t(notice.code === "MARKET_CLOSED" ? "marketClosedNotice" : "marketClosedQueuedNotice");
      const nextOpen = typeof notice.details?.nextOpen === "string" ? notice.details.nextOpen : undefined;
      return nextOpen ? `${base} ${t("nextOpenLabel")} ${dateTime(nextOpen, locale)}` : base;
    }
    default: return notice.message;
  }
}

export function verificationText(result: ExecutionVerificationResult, t: Translator): string {
  switch (result.status) {
    case "confirmed_pending": return t("verificationConfirmedPending");
    case "likely_executed": return t("verificationLikelyExecuted");
    case "still_pending": return t("verificationStillPending");
    case "no_longer_pending": return t("verificationNoLongerPending");
    case "no_evidence": return t("verificationNoEvidence");
    default: return result.message;
  }
}

export function sizingText(
  sizing: OrderSizing,
  instrument: Instrument | undefined,
  locale: SupportedLocale,
  t: Translator,
): string {
  if (sizing.mode === "quantity") return `${t("exactQuantity")} · ${num(sizing.quantity, locale)}`;
  if (sizing.mode === "notional") return `${t("targetAmount")} · ${num(sizing.amount, locale)} ${sizing.currency ?? instrument?.currencyCode ?? ""}${sizing.fxRateToInstrumentCurrency ? ` · ${t("fxRate")} ${num(sizing.fxRateToInstrumentCurrency, locale, 6)}` : ""}`.trim();
  if (sizing.mode === "cash_percent") return `${t("cashPercentage")} · ${num(sizing.percent, locale)}%${sizing.fxRateToInstrumentCurrency ? ` · ${t("fxRate")} ${num(sizing.fxRateToInstrumentCurrency, locale, 6)}` : ""}`;
  if (sizing.mode === "position_percent") return `${t("positionPercentage")} · ${num(sizing.percent, locale)}%`;
  return t("allAvailableShares");
}

export function activityLabel(event: ActivityEvent, t: Translator): string {
  switch (event.type) {
    case "order_prepared": return t("activityOrderPrepared");
    case "order_submitted": return t("activityOrderSubmitted");
    case "order_rejected": return t("activityOrderRejected");
    case "order_status_unknown": return t("activityOrderUnknown");
    case "order_verification": return t("activityVerified");
    case "cancel_prepared": return t("activityCancelPrepared");
    case "cancel_submitted": return t("activityCancelSubmitted");
    case "cancel_rejected": return t("activityCancelRejected");
    case "cancel_status_unknown": return t("activityCancelUnknown");
    case "basket_prepared": return t("activityBasketPrepared");
    case "basket_submitted": return t("activityBasketSubmitted");
    case "plan_due": return t("activityPlanDue");
    case "plan_auto_executed": return t("activityPlanAutoExecuted");
    case "plan_skipped": return t("activityPlanSkipped");
    case "protective_linked": return t("activityProtectiveLinked");
    case "protective_sibling_cancelled": return t("activityProtectiveCancelled");
    case "protective_unlinked": return t("activityProtectiveUnlinked");
    default: return String((event as ActivityEvent).type);
  }
}

export function policyRuleLabel(rule: PolicyCheck["rule"], t: Translator): string {
  switch (rule) {
    case "allowed_tickers": return t("policyRuleAllowedTickers");
    case "blocked_tickers": return t("policyRuleBlockedTickers");
    case "allowed_types": return t("policyRuleAllowedTypes");
    case "max_position_weight": return t("policyRuleMaxPositionWeight");
    case "daily_order_limit": return t("policyRuleDailyOrderLimit");
    case "daily_notional_limit": return t("policyRuleDailyNotionalLimit");
    case "market_closed": return t("policyRuleMarketClosed");
    case "reference_age": return t("policyRuleReferenceAge");
    default: return String(rule);
  }
}

export function policyStatusLabel(status: PolicyCheck["status"], t: Translator): string {
  switch (status) {
    case "pass": return t("policyPass");
    case "warn": return t("policyWarn");
    case "skip": return t("policySkip");
    case "block": return t("policyBlock");
    default: return String(status);
  }
}
