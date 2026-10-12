import type { AlertCondition, BasketDraftPayload, BasketExecutionResult, BasketLeg, BasketPurpose, PolicyCheck, RebalanceNote, RebalancePlan } from "../../shared/automation";
import type { ActivityEvent, ExecutionVerificationResult, Instrument, OrderNotice, OrderSizing, OrderType, StructuredError, TimeValidity, TradingEnvironment } from "../../shared/contracts";
import type { PieChangePreview, PieChangeResult, PieInstrumentIssue } from "../../shared/pies";
import { localeTag, type MessageKey, type SupportedLocale } from "../i18n";
import { amount, dateTime, money, num, pct, qty } from "./format";
import { instrumentLabel, type InstrumentBook } from "./instruments";
import { STOPS_BASKET_TITLE } from "../../shared/protection";

export type Translator = (key: MessageKey) => string;

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Sentences one after another, leaving out empty ones: Chinese sets them without a space between. */
export function sentences(locale: SupportedLocale, parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(locale === "zh-CN" ? "" : " ");
}

/** Picks the singular or plural message for a count with Intl.PluralRules, then fills {count}. */
export function plural(count: number, locale: SupportedLocale, one: string, other: string, values: Record<string, string> = {}): string {
  const rule = new Intl.PluralRules(localeTag(locale)).select(count);
  return fill(rule === "one" ? one : other, { count: num(count, locale), ...values });
}

const COUNT_KEYS = {
  candidates: ["countCandidatesOne", "countCandidatesOther"],
  orders: ["countOrdersOne", "countOrdersOther"],
  checksPassed: ["countChecksPassedOne", "countChecksPassedOther"],
} as const satisfies Record<string, readonly [MessageKey, MessageKey]>;

export function countText(kind: keyof typeof COUNT_KEYS, count: number, t: Translator, locale: SupportedLocale): string {
  const [one, other] = COUNT_KEYS[kind];
  return plural(count, locale, t(one), t(other));
}

const CONDITION_KEY: Record<AlertCondition, MessageKey> = {
  above: "alertAbove",
  below: "alertBelow",
  trailing_drop: "alertTrailing",
  gain_percent: "alertGain",
  loss_percent: "alertLoss",
  day_move: "alertDayMove",
};

/** "At or above", "Drop from high of" …, followed in the UI by the price or percent. */
export function alertConditionLabel(condition: AlertCondition, t: Translator): string {
  return t(CONDITION_KEY[condition]);
}

export function envLabel(environment: TradingEnvironment, t: Translator): string {
  return environment === "live" ? t("live") : t("demo");
}

export function orderTypeLabel(type: OrderType | string | undefined, t: Translator): string {
  switch (String(type ?? "").toLowerCase()) {
    case "market": return t("market");
    case "limit": return t("limit");
    case "stop": return t("stop");
    case "stop_limit": return t("stopLimit");
    default: return String(type ?? "");
  }
}

export function validityLabel(validity: TimeValidity | string | undefined, t: Translator): string {
  if (validity === "GOOD_TILL_CANCEL") return t("gtc");
  if (validity === "DAY" || validity === undefined) return t("day");
  return String(validity);
}

const STATUS_KEYS: Record<string, MessageKey> = {
  LOCAL: "orderStatusSending",
  UNCONFIRMED: "orderStatusSending",
  CONFIRMED: "orderStatusOpen",
  NEW: "orderStatusOpen",
  PARTIALLY_FILLED: "orderStatusPartial",
  FILLED: "orderStatusFilled",
  CANCELLING: "orderStatusCancelling",
  CANCELLED: "orderStatusCancelled",
  REJECTED: "orderStatusRejected",
  REPLACING: "orderStatusReplacing",
  REPLACED: "orderStatusReplaced",
};

/** Trading 212 order statuses (NEW, PARTIALLY_FILLED, …) as words; unknown ones are shown as sent. */
export function orderStatusLabel(status: string, t: Translator): string {
  const key = STATUS_KEYS[status.toUpperCase()];
  return key ? t(key) : status;
}

const TYPE_KEYS: Record<string, MessageKey> = {
  STOCK: "typeStock",
  ETF: "typeEtf",
  WARRANT: "typeWarrant",
  CRYPTO: "typeCrypto",
  CRYPTOCURRENCY: "typeCrypto",
  FUTURES: "typeFutures",
  INDEX: "typeIndex",
  FOREX: "typeForex",
  CVR: "typeCvr",
  CORPACT: "typeCorpAct",
  UNKNOWN: "typeOther",
  CASH: "typeCash",
};

export function instrumentTypeLabel(type: string, t: Translator): string {
  const key = TYPE_KEYS[type.toUpperCase()];
  return key ? t(key) : type;
}

const PROVIDER_NAMES: Record<string, string> = { stooq: "Stooq", finnhub: "Finnhub", twelvedata: "Twelve Data", alphavantage: "Alpha Vantage" };

export function quoteProviderLabel(provider: string, t: Translator): string {
  if (!provider || provider === "none") return t("quoteNone");
  if (provider === "sample") return t("quoteSample");
  return PROVIDER_NAMES[provider] ?? provider;
}

export function formatProblem(problem: StructuredError, t: Translator, locale: SupportedLocale): string {
  const details = problem.details ?? {};
  const number = (key: string) => typeof details[key] === "number" ? num(details[key] as number, locale) : String(details[key] ?? "—");
  const currency = typeof details.currency === "string" && details.currency ? details.currency : undefined;
  const sum = (key: string) => (typeof details[key] === "number" ? amount(details[key] as number, currency, locale) : "—");
  switch (problem.code) {
    case "CREDENTIALS_NOT_CONFIGURED": return t("errorCredentials");
    case "INSTRUMENT_NOT_FOUND": return t("errorInstrumentNotFound");
    case "INSTRUMENT_AMBIGUOUS": return details.matches ? `${t("errorInstrumentAmbiguous")} ${details.matches}` : t("errorInstrumentAmbiguous");
    case "NO_AVAILABLE_POSITION": return t("errorNoPosition");
    case "NO_AVAILABLE_CASH": return t("errorNoCash");
    case "INSUFFICIENT_SELLABLE_QUANTITY": return typeof details.requested === "number" && typeof details.available === "number" ? `${t("errorSellable")} ${qty(details.requested, locale)} / ${qty(details.available, locale)}` : t("errorSellable");
    case "INSUFFICIENT_CASH": return typeof details.requested === "number" && typeof details.available === "number" ? `${t("errorCash")} ${sum("requested")} / ${sum("available")}` : t("errorCash");
    case "ORDER_NOTIONAL_LIMIT": return typeof details.requested === "number" && typeof details.limit === "number" ? `${t("errorNotionalLimit")} ${sum("requested")} / ${sum("limit")}` : t("errorNotionalLimit");
    case "ORDER_QUANTITY_LIMIT": return typeof details.requested === "number" && typeof details.limit === "number" ? `${t("errorQuantityLimit")} ${number("requested")} / ${number("limit")}` : t("errorQuantityLimit");
    case "FX_RATE_REQUIRED": return fill(t("errorFxRate"), { from: String(details.from ?? ""), to: String(details.to ?? "") });
    case "PRICE_OUT_OF_RANGE": {
      if (typeof details.price !== "number" || typeof details.last !== "number") return problem.message;
      const field = details.field === "stopPrice" ? t("stopPrice") : t("limitPrice");
      const text = fill(t("errorPriceOutOfRange"), { field, price: sum("price"), last: sum("last") });
      return currency === "GBX" ? `${text} ${t("errorPriceOutOfRangeGbx")}` : text;
    }
    case "REFERENCE_PRICE_REQUIRED": return t("errorReferencePrice");
    case "UNSUPPORTED_EXTENDED_HOURS": return t("errorExtendedHours");
    case "CONFIRMATION_EXPIRED": return t("errorConfirmationExpired");
    case "VERIFICATION_NOT_FOUND": return t("errorVerificationMissing");
    case "BROKER_RATE_LIMITED": return t("errorBrokerRateLimit");
    case "BROKER_REQUEST_FAILED": return t("errorBroker");
    case "EXECUTION_STATUS_UNKNOWN": return t("errorUnknownExecution");
    case "EXECUTION_BUSY": return t("errorExecutionBusy");
    case "RISK_CHANGED": {
      const account = typeof details.accountCurrency === "string" ? details.accountCurrency : undefined;
      if (typeof details.loss === "number") return fill(t("errorRiskChangedLoss"), { loss: amount(details.loss, account, locale) });
      if (typeof details.stopLossPrice === "number") return fill(t("errorRiskChangedStop"), { stop: sum("stopLossPrice") });
      return problem.message;
    }
    case "RISK_CHECK_UNAVAILABLE":
      if (details.missing === "fx_rate") return fill(t("errorRiskRateUnavailable"), { from: String(details.from ?? ""), to: String(details.to ?? "") });
      if (details.missing === "account_currency") return t("errorRiskCurrencyUnavailable");
      if (details.missing === "price") return t("errorRiskPriceUnavailable");
      return details.missing === "quote" ? t("errorRiskQuoteUnavailable") : problem.message;
    case "POLICY_BLOCKED": return problem.message ? `${t("errorPolicyBlocked")} ${problem.message}` : t("errorPolicyBlocked");
    case "PLAN_NOT_FOUND": return t("errorPlanNotFound");
    case "PIE_NOT_FOUND": return t("errorPieNotFound");
    case "ALERT_NOT_FOUND": return t("errorAlertNotFound");
    case "JOURNAL_ENTRY_NOT_FOUND": return t("errorJournalNotFound");
    case "LIVE_ACK_REQUIRED": return t("errorLiveAckRequired");
    case "INVALID_INPUT": return problem.message;
    default: return problem.message || t("errorInternal");
  }
}

export function noticeText(notice: OrderNotice, t: Translator, locale: SupportedLocale): string {
  const details = notice.details ?? {};
  const currency = typeof details.currency === "string" && details.currency ? details.currency : undefined;
  const price = (key: string) => (typeof details[key] === "number" ? amount(details[key] as number, currency, locale) : undefined);
  switch (notice.code) {
    case "LIVE_FUNDS": return t("liveFundsNotice");
    case "MARKET_SLIPPAGE": return t("marketSlippageNotice");
    case "STOP_SLIPPAGE": return t(details.side === "sell" ? "noticeStopSlippageSell" : details.riskSized === true ? "noticeStopSlippageRisk" : "noticeStopSlippageBuy");
    case "REFERENCE_PRICE_STALE": {
      const seconds = typeof details.ageSeconds === "number" ? details.ageSeconds : undefined;
      return seconds === undefined ? t("referenceStaleNotice") : `${t("referenceStaleNotice")} ${num(Math.round(seconds / 60), locale, 0)} min`;
    }
    case "REFERENCE_PRICE_TIME_UNKNOWN": return t("referenceTimeUnknownNotice");
    case "FX_RATE_STALE": {
      const seconds = typeof details.ageSeconds === "number" ? details.ageSeconds : undefined;
      return seconds === undefined ? t("fxStaleNotice") : `${t("fxStaleNotice")} ${num(Math.round(seconds / 60), locale, 0)} min`;
    }
    case "CROSS_CURRENCY_FUNDS_CHECK": return t("crossCurrencyNotice");
    case "NOTIONAL_ESTIMATE_UNAVAILABLE": return t("notionalUnavailableNotice");
    case "MARKET_CLOSED":
    case "MARKET_CLOSED_QUEUED": {
      const base = t(notice.code === "MARKET_CLOSED" ? "marketClosedNotice" : "marketClosedQueuedNotice");
      const nextOpen = typeof details.nextOpen === "string" ? details.nextOpen : undefined;
      return nextOpen ? `${base} ${t("nextOpenLabel")} ${dateTime(nextOpen, locale)}` : base;
    }
    case "MARKET_HOURS_UNKNOWN":
      if (details.reason === "unavailable") return t("noticeHoursUnavailable");
      if (details.reason === "no_schedule") return t("noticeHoursNoSchedule");
      return notice.message;
    case "STOP_ALREADY_TRIGGERED": {
      const stop = price("stopPrice");
      const last = price("last");
      return stop && last ? fill(t("noticeStopTriggered"), { stop, last }) : notice.message;
    }
    case "LIMIT_FILLS_AT_ONCE": {
      const limit = price("limitPrice");
      const last = price("last");
      return limit && last ? fill(t("noticeLimitAtOnce"), { limit, last }) : notice.message;
    }
    case "RISK_OVER_BUDGET": {
      const stop = price("stopLossPrice");
      const account = typeof details.accountCurrency === "string" ? details.accountCurrency : undefined;
      const loss = typeof details.loss === "number" ? amount(details.loss, account, locale) : undefined;
      const budget = typeof details.budget === "number" ? amount(details.budget, account, locale) : undefined;
      return stop && loss && budget ? fill(t("noticeRiskOverBudget"), { stop, loss, budget }) : notice.message;
    }
    case "RISK_STOP_ABOVE_PRICE": {
      const stop = price("stopLossPrice");
      return stop ? fill(t("noticeRiskStopAbovePrice"), { stop }) : notice.message;
    }
    case "PRICE_FAR_FROM_LAST": {
      const percent = typeof details.percent === "number" ? details.percent : undefined;
      const last = price("last");
      if (percent === undefined || !last) return notice.message;
      return fill(t(percent >= 0 ? "noticeFarAbove" : "noticeFarBelow"), { percent: pct(Math.abs(percent) / 100, locale, 0), last });
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
  accountCurrency?: string,
): string {
  if (sizing.mode === "quantity") return `${t("exactQuantity")} · ${qty(sizing.quantity, locale)}`;
  if (sizing.mode === "notional") return `${t("targetAmount")} · ${amount(sizing.amount, sizing.currency ?? instrument?.currencyCode, locale)}${sizing.fxRateToInstrumentCurrency ? ` · ${t("fxRate")} ${num(sizing.fxRateToInstrumentCurrency, locale, 6)}` : ""}`;
  if (sizing.mode === "cash_percent") return `${t("cashPercentage")} · ${num(sizing.percent, locale)}%${sizing.fxRateToInstrumentCurrency ? ` · ${t("fxRate")} ${num(sizing.fxRateToInstrumentCurrency, locale, 6)}` : ""}`;
  if (sizing.mode === "position_percent") return `${t("positionPercentage")} · ${num(sizing.percent, locale)}%`;
  if (sizing.mode === "risk") {
    const budget = sizing.percent !== undefined ? fill(t("riskOfAccount"), { percent: num(sizing.percent, locale, 2) }) : amount(sizing.amount, accountCurrency, locale);
    return `${t("riskSizing")} · ${budget} · ${fill(t("riskStopAt"), { price: amount(sizing.stopLossPrice, instrument?.currencyCode, locale) })}`;
  }
  return t("allAvailableShares");
}

export function activityLabel(event: ActivityEvent, t: Translator): string {
  switch (event.type) {
    case "order_prepared": return t("activityOrderPrepared");
    case "order_submitted": return t("activityOrderSubmitted");
    case "order_rejected": return t("activityOrderRejected");
    case "order_status_unknown": return t("activityOrderUnknown");
    case "order_verification": return t("activityVerified");
    case "order_filled": return t("activityOrderFilled");
    case "order_partly_filled": return t("activityOrderPartlyFilled");
    case "order_closed": return t("activityOrderClosed");
    case "order_outcome_unknown": return t("activityOrderOutcomeUnknown");
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
    case "protective_attention": return t("activityProtectiveAttention");
    case "pie_prepared": return t("activityPiePrepared");
    case "pie_submitted": return t("activityPieSubmitted");
    case "pie_rejected": return t("activityPieRejected");
    case "pie_status_unknown": return t("activityPieUnknown");
    case "price_alert_triggered": return t("activityPriceAlert");
    case "account_alert_triggered": return t("activityAccountAlert");
    case "allocation_drift": return t("activityAllocationDrift");
    case "daily_digest": return t("activityDailyDigest");
    default: return String((event as ActivityEvent).type);
  }
}

/** Activity that needs a look from the person: uncertain, rejected, skipped or flagged. */
export function activityNeedsAttention(event: ActivityEvent): boolean {
  return event.type.includes("unknown") || event.type.includes("rejected") || event.type === "plan_skipped" || event.type === "protective_attention";
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
      const allowed = (text("allowed") ?? "").split(/,\s*/).filter(Boolean).map((item) => instrumentTypeLabel(item, t)).join(", ");
      return fill(t(check.status === "pass" ? "policyMsgTypePass" : "policyMsgTypeBlock"), { type: type ? instrumentTypeLabel(type, t) : "—", allowed });
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
      const sum = (value: number) => amount(value, currency, locale);
      return fill(t(check.status === "block" ? "policyMsgNotionalBlock" : "policyMsgNotionalPass"), { next: sum(next), limit: sum(limit) });
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
export function rebalanceNoteText(note: RebalanceNote, t: Translator, locale: SupportedLocale, book?: InstrumentBook): string {
  const details = note.details ?? {};
  const value = (key: string) => details[key];
  switch (note.code) {
    case "untargeted_kept": {
      const count = Number(value("count"));
      return plural(count, locale, t("rebalanceNoteUntargetedOne"), t("rebalanceNoteUntargeted"));
    }
    case "sell_limited": {
      const sellable = Number(value("sellable"));
      const ticker = String(value("ticker") ?? "");
      return plural(sellable, locale, t("rebalanceNoteSellLimitedOne"), t("rebalanceNoteSellLimited"), { ticker: ticker ? instrumentLabel(ticker, book).name : "", sellable: qty(sellable, locale) });
    }
    case "buys_scaled": {
      const currency = String(value("currency") ?? "");
      const budget = Number(value("budget"));
      return fill(t("rebalanceNoteScaled"), { percent: pct(Number(value("scale")), locale, 0), budget: amount(budget, currency || undefined, locale) });
    }
    case "implied_rates": return fill(t("rebalanceNoteImplied"), { currencies: String(value("currencies") ?? "") });
    case "quoted_rates": return fill(t("rebalanceNoteQuoted"), { currencies: String(value("currencies") ?? ""), source: String(value("source") ?? ""), asOf: dateTime(String(value("asOf") ?? ""), locale) });
    case "buy_only": {
      const currency = String(value("currency") ?? "");
      return fill(t("rebalanceNoteBuyOnly"), { budget: amount(Number(value("budget")), currency || undefined, locale) });
    }
    case "amount_capped": {
      const currency = String(value("currency") ?? "") || undefined;
      return fill(t("rebalanceNoteCapped"), { available: amount(Number(value("available")), currency, locale), amount: amount(Number(value("amount")), currency, locale) });
    }
    case "no_cash": return t("rebalanceNoteNoCash");
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

// ---- Server text that has no code: translated from the payload's structure, with the server's words as the fallback ----

type BasketShape = Pick<BasketDraftPayload, "purpose" | "title"> & { legs: BasketLeg[] };

/** Titles the server writes for its own baskets ("Rebalance", "Protect VUSA"); titles from the person or the model stay. */
export function basketTitle(basket: BasketShape, t: Translator, book?: InstrumentBook): string {
  const title = basket.title.trim();
  if (basket.purpose === "rebalance" && (title === "Rebalance" || !title)) return t("basketTitleRebalance");
  if (basket.purpose === "rebalance" && title === "Invest cash by targets") return t("basketTitleInvestCash");
  if (basket.purpose === "protective" && title === STOPS_BASKET_TITLE) return t("basketTitleStops");
  if (basket.purpose === "protective" && (title.startsWith("Protect ") || !title)) {
    const leg = basket.legs[0];
    const name = leg ? instrumentLabel(leg.draft.ticker, book, leg.instrument).name : title.slice("Protect ".length);
    return fill(t("basketTitleProtect"), { name });
  }
  if (!title || title === "Order basket") return t("basketDraft");
  return title;
}

/** Why a leg is in the basket, from its purpose and order type rather than the server's sentence. */
export function legReason(leg: BasketLeg, basket: Pick<BasketDraftPayload, "purpose" | "title">, t: Translator): string | undefined {
  if (basket.purpose === "protective") {
    // The portfolio stop basket says why each stop sits where it does.
    if (leg.reason === "Matches the existing stop") return t("stopsReasonMatch");
    const drop = /^(\d+(?:\.\d+)?)% below the last price$/.exec(leg.reason ?? "");
    if (drop) return fill(t("stopsReasonDrop"), { percent: `${drop[1]}%` });
    if (leg.draft.type === "stop") return t("stopLoss");
    if (leg.draft.type === "limit") return t("takeProfit");
  }
  if (basket.purpose === "dca" && leg.reason?.startsWith("Plan ")) return fill(t("legReasonPlan"), { label: basket.title });
  return leg.reason;
}

const PROTECTIVE_NOTES: Record<string, MessageKey> = {
  "Both orders stay at Trading 212 until they fill or you cancel them.": "protectiveNoteStays",
  "TradePilot links the two orders: about a minute after one fills, it cancels the other. Trading 212 may reject the second if the first already reserves the shares; then only the first is placed.": "protectiveNoteLinked",
  "They are not linked: when one fills, cancel the other. Trading 212 may reject the second if the first already reserves the shares.": "protectiveNoteUnlinked",
  "A Stop order becomes a Market order when triggered, so a gap can fill it below the stop price.": "protectiveNoteGap",
  "Each order stays at Trading 212 until it triggers or you cancel it.": "stopsNoteStays",
};

/** A basket note in the widget's language. Plan and protective notes are recognised by their wording and rebuilt from their values. */
export function basketNoteText(note: string, basket: BasketShape, t: Translator, locale: SupportedLocale, book?: InstrumentBook): string {
  if (basket.purpose === "protective") {
    const key = PROTECTIVE_NOTES[note];
    if (key === "protectiveNoteStays" && basket.legs.length === 1) return t("protectiveNoteStaysOne");
    if (key) return t(key);
    const price = /^A holding that already has a stop gets one at the same price for its uncovered shares; the others start (\d+(?:\.\d+)?)% below the last price\.$/.exec(note);
    if (price) return fill(t("stopsNotePrice"), { percent: num(Number(price[1]), locale, 2) });
    const left = /^(\d+) more holding\(s\) without a full stop were left out; a basket holds at most (\d+) orders\.$/.exec(note);
    if (left) return fill(t("stopsNoteLeft"), { count: num(Number(left[1]), locale), max: num(Number(left[2]), locale) });
  }
  if (basket.purpose === "dca") {
    const legs = (text: string) => [...text.matchAll(/(\d+(?:\.\d+)?) ([A-Z]{3}) ([^\s,]+)/g)]
      .map(([, value, currency, ticker]) => `${money(Number(value), currency!, locale)} ${instrumentLabel(ticker!, book).name}`).join(locale === "zh-CN" ? "、" : ", ");
    const sized = /^Sized from each holding's last broker price, or an external quote for legs not held yet; (.+)\.$/.exec(note);
    if (sized) return fill(t("dcaNoteSized"), { legs: legs(sized[1]!) });
    const fx = /^Amounts in (.+?) use (?:the exchange rate your holdings imply or, where none does, (.+?)'s|the exchange rate the broker's valuation of your holdings implies); Trading 212 converts at its own rate and fee\.$/.exec(note);
    if (fx) return fill(t(fx[2] ? "dcaNoteFxQuoted" : "dcaNoteFxImplied"), { currencies: fx[1]!, source: fx[2] ?? "" });
    const small = /^([^\s:]+): (\d+(?:\.\d+)?) ([A-Z]{3}) is less than the smallest tradable quantity\.$/.exec(note);
    if (small) return fill(t("dcaNoteTooSmall"), { name: instrumentLabel(small[1]!, book).name, amount: money(Number(small[2]), small[3]!, locale) });
  }
  return note;
}

/** The headline of a basket result, counted from its legs; the server's English sentence is not shown. */
export function basketResultText(result: BasketExecutionResult, t: Translator, locale: SupportedLocale): string {
  const submitted = result.legs.filter((leg) => leg.result?.ok).length;
  const total = result.legs.length;
  const headline = plural(total, locale, t("basketResultCountOne"), t("basketResultCount"), { submitted: num(submitted, locale), env: envLabel(result.environment, t) });
  const stop = result.legs.map((leg) => leg.skipped).find((reason) => reason?.startsWith("Not sent: an earlier order's result is uncertain"));
  return stop ? `${headline} ${t("legStopUncertain")}` : headline;
}

/** Why a basket leg was not sent, in the widget's language when the server's reason is one it knows. */
export function legSkipText(reason: string, t: Translator, book?: InstrumentBook): string {
  if (reason.startsWith("Not sent: an earlier order's result is uncertain")) return t("legStopUncertain");
  const unfunded = /^Not sent: the sell of (\S+) that funds it was (not sent|rejected)\.$/.exec(reason);
  if (unfunded) return fill(t(unfunded[2] === "rejected" ? "legStopUnfundedRejected" : "legStopUnfundedNotSent"), { name: instrumentLabel(unfunded[1]!, book).name });
  if (reason === "Not sent.") return t("legNotSent");
  const checks = /^The basket no longer passes its checks: (.*)$/s.exec(reason);
  if (checks) return `${t("legStopChecks")} ${checks[1]}`;
  return reason;
}

/** The message of a pie change preview in the widget's language, with values from the preview itself. */
export function pieNoticeText(notice: string, preview: PieChangePreview, t: Translator, locale: SupportedLocale, book?: InstrumentBook): string {
  if (notice.startsWith("Trading 212 marks the pies API as deprecated")) return t("pieNoticeDeprecated");
  if (notice.startsWith("LIVE: this changes a pie")) return t("pieNoticeLive");
  if (notice.startsWith("Removing ")) {
    const owned = new Map((preview.current?.instruments ?? []).map((item) => [item.ticker, item.ownedQuantity]));
    const removed = preview.changes.filter((change) => change.to === 0 && (owned.get(change.ticker) ?? 0) > 0);
    if (!removed.length) return notice;
    return fill(t("pieNoticeRemoved"), { names: removed.map((item) => instrumentLabel(item.ticker, book).name).join(locale === "zh-CN" ? "、" : ", ") });
  }
  if (notice.startsWith("New target shares apply to future investments")) return t("pieNoticeUpdate");
  if (notice.startsWith("Creating a pie invests nothing")) return t("pieNoticeCreate");
  if (notice.startsWith("The copy has the same slices")) return t("pieNoticeDuplicate");
  if (notice.startsWith("This pie holds nothing")) return t("pieNoticeDeleteEmpty");
  if (notice.startsWith("This pie holds about") && preview.current) return fill(t("pieNoticeDelete"), { value: amount(preview.current.value, preview.current.currency, locale) });
  return notice;
}

export function pieResultText(result: PieChangeResult, t: Translator): string {
  if (result.ok) return fill(t("pieResultSent"), { env: envLabel(result.environment, t) });
  if (result.status === "unknown") return t("pieResultUnknown");
  if (result.message.includes("(403)")) return t("pieResult403");
  return result.message;
}

const ISSUE_KEYS: Record<string, MessageKey> = {
  DELISTED: "pieIssueDelisted",
  SUSPENDED: "pieIssueSuspended",
  NO_LONGER_TRADABLE: "pieIssueNotTradable",
  MAX_POSITION_SIZE_REACHED: "pieIssueMaxPosition",
  APPROACHING_MAX_POSITION_SIZE: "pieIssueNearMaxPosition",
  COMPLEX_INSTRUMENT_APP_TEST_REQUIRED: "pieIssueComplex",
};

export function pieIssueText(issue: PieInstrumentIssue, t: Translator): string {
  const key = ISSUE_KEYS[issue.name];
  return key ? t(key) : fill(t("pieIssueOther"), { name: issue.name.replaceAll("_", " ").toLowerCase() });
}

export type ExecutionKind = "order" | "cancel";

/** A successful order or cancellation, said in the widget's language; failures use the structured error. */
export function executionText(kind: ExecutionKind, environment: TradingEnvironment, t: Translator): string {
  return fill(t(kind === "cancel" ? "execCancelSubmitted" : "execOrderSubmitted"), { env: envLabel(environment, t) });
}

/** What a basket is for. A protective basket of only stops (or only take-profits) says just that. */
export function purposeLabel(purpose: BasketPurpose, t: Translator, legs: BasketLeg[] = []): string {
  const types = new Set(legs.map((leg) => (leg.draft.type === "stop_limit" ? "stop" : leg.draft.type)));
  switch (purpose) {
    case "rebalance": return t("basketPurposeRebalance");
    case "protective": return types.size === 1 && types.has("stop") ? t("stopLoss") : types.size === 1 && types.has("limit") ? t("takeProfit") : t("basketPurposeProtective");
    case "dca": return t("basketPurposeDca");
    default: return t("basketPurposeCustom");
  }
}

