import type { PolicyCheck, RebalanceNote, RebalancePlan } from "../../shared/automation";
import type { ActivityEvent, ExecutionVerificationResult, Instrument, OrderNotice, OrderSizing, StructuredError } from "../../shared/contracts";
import type { MessageKey, SupportedLocale } from "../i18n";
import { dateTime, money, num, pct } from "./format";

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
    case "FX_RATE_REQUIRED": return fill(t("errorFxRate"), { from: String(details.from ?? ""), to: String(details.to ?? "") });
    case "REFERENCE_PRICE_REQUIRED": return t("errorReferencePrice");
    case "UNSUPPORTED_EXTENDED_HOURS": return t("errorExtendedHours");
    case "CONFIRMATION_EXPIRED": return t("errorConfirmationExpired");
    case "VERIFICATION_NOT_FOUND": return t("errorVerificationMissing");
    case "BROKER_RATE_LIMITED": return t("errorBrokerRateLimit");
    case "BROKER_REQUEST_FAILED": return t("errorBroker");
    case "EXECUTION_STATUS_UNKNOWN": return t("errorUnknownExecution");
    case "POLICY_BLOCKED": return problem.message ? `${t("errorPolicyBlocked")} ${problem.message}` : t("errorPolicyBlocked");
    case "PLAN_NOT_FOUND": return t("errorPlanNotFound");
    case "PIE_NOT_FOUND": return t("errorPieNotFound");
    case "ALERT_NOT_FOUND": return t("errorAlertNotFound");
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
    case "pie_prepared": return t("activityPiePrepared");
    case "pie_submitted": return t("activityPieSubmitted");
    case "pie_rejected": return t("activityPieRejected");
    case "pie_status_unknown": return t("activityPieUnknown");
    case "price_alert_triggered": return t("activityPriceAlert");
    case "daily_digest": return t("activityDailyDigest");
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

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** The policy check in the widget's language, built from its details; the server's English text is the fallback. */
export function policyMessage(check: PolicyCheck, t: Translator, locale: SupportedLocale): string {
  const details = check.details ?? {};
  const text = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : undefined);
  const number = (key: string) => (typeof details[key] === "number" ? (details[key] as number) : undefined);
  const ticker = text("ticker");
  switch (check.rule) {
    case "allowed_tickers":
      return ticker ? fill(t(check.status === "pass" ? "policyMsgAllowedTickerPass" : "policyMsgAllowedTickerBlock"), { ticker }) : check.message;
    case "blocked_tickers":
      return ticker ? fill(t("policyMsgBlockedTicker"), { ticker }) : check.message;
    case "allowed_types": {
      const type = text("type");
      if (type === undefined) return check.message;
      return fill(t(check.status === "pass" ? "policyMsgTypePass" : "policyMsgTypeBlock"), { type: type || "—", allowed: text("allowed") ?? "" });
    }
    case "max_position_weight": {
      if (check.status === "skip") return t("policyMsgWeightSkip");
      const weight = number("resultingWeight");
      const limit = number("limit");
      if (!ticker || weight === undefined || limit === undefined) return check.message;
      return fill(t(check.status === "block" ? "policyMsgWeightBlock" : "policyMsgWeightPass"), { ticker, weight: pct(weight, locale), limit: pct(limit, locale) });
    }
    case "daily_order_limit": {
      const today = number("ordersToday");
      const limit = number("limit");
      if (today === undefined || limit === undefined) return check.message;
      return fill(t(check.status === "block" ? "policyMsgOrdersBlock" : "policyMsgOrdersPass"), { next: num(today + 1, locale, 0), limit: num(limit, locale, 0) });
    }
    case "daily_notional_limit": {
      if (check.status === "warn") return t("policyMsgNotionalWarn");
      const next = number("next");
      const limit = number("limit");
      const currency = text("currency");
      if (next === undefined || limit === undefined) return check.message;
      const amount = (value: number) => (currency ? money(value, currency, locale) : num(value, locale));
      return fill(t(check.status === "block" ? "policyMsgNotionalBlock" : "policyMsgNotionalPass"), { next: amount(next), limit: amount(limit) });
    }
    case "market_closed":
      return t("policyMsgMarketClosed");
    case "reference_age": {
      const limit = number("limit");
      const age = number("ageSeconds");
      if (limit === undefined) return check.message;
      if (age === undefined) return fill(t("policyMsgReferenceUndated"), { limit: num(limit, locale, 0) });
      return fill(t(check.status === "block" ? "policyMsgReferenceBlock" : "policyMsgReferencePass"), { age: num(age, locale, 0), limit: num(limit, locale, 0) });
    }
    default:
      return check.message;
  }
}

/** A rebalance note in the widget's language; notes without a known code keep the server's text. */
export function rebalanceNoteText(note: RebalanceNote, t: Translator, locale: SupportedLocale): string {
  const details = note.details ?? {};
  const value = (key: string) => details[key];
  switch (note.code) {
    case "untargeted_kept": return fill(t("rebalanceNoteUntargeted"), { count: num(Number(value("count")), locale, 0) });
    case "sell_limited": return fill(t("rebalanceNoteSellLimited"), { ticker: String(value("ticker") ?? ""), sellable: num(Number(value("sellable")), locale) });
    case "buys_scaled": {
      const currency = String(value("currency") ?? "");
      const budget = Number(value("budget"));
      return fill(t("rebalanceNoteScaled"), { percent: pct(Number(value("scale")), locale, 0), budget: currency ? money(budget, currency, locale) : num(budget, locale) });
    }
    case "implied_rates": return fill(t("rebalanceNoteImplied"), { currencies: String(value("currencies") ?? "") });
    case "quoted_rates": return fill(t("rebalanceNoteQuoted"), { currencies: String(value("currencies") ?? ""), source: String(value("source") ?? ""), asOf: dateTime(String(value("asOf") ?? ""), locale) });
    case "nothing_possible": return t("rebalanceNoteNothing");
    case "within_threshold": return t("rebalanceNoteWithin");
    case "price_source": return t("rebalanceNotePrices");
    default: return note.message;
  }
}

export function rebalanceSkipText(item: RebalancePlan["skipped"][number], t: Translator): string {
  switch (item.code) {
    case "no_fx_rate": return item.currency ? fill(t("rebalanceSkipNoFx"), { currency: item.currency }) : item.reason;
    case "no_price": return t("rebalanceSkipNoPrice");
    case "below_one_share": return t("rebalanceSkipOneShare");
    case "below_minimum": return t("rebalanceSkipMinimum");
    default: return item.reason;
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
