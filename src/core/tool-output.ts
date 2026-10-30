// What each tool returns as structured content, declared as its `outputSchema` so a host can plan with the shape and
// check it. Each is an open object: `kind` names the payload and the fields listed are typed (and may be absent or
// null, as a payload leaves out what does not apply); payloads carry more than is listed, and the text and
// docs/ANALYTICS.md say what each figure means. The server checks every result against its tool's schema, so a field
// is listed only with the type every payload gives it; a tool failure is a result with `isError`, which is not checked.

import { z } from "zod";

type FieldType = "s" | "n" | "b" | "o" | "a" | "u";

const TYPES: Record<FieldType, () => z.ZodType> = {
  s: () => z.string(),
  // Any number: a figure that cannot be computed is NaN, which is still a result (JSON carries it as null).
  n: () => z.unknown().refine((value) => typeof value === "number", "Expected a number").meta({ type: "number" }),
  b: () => z.boolean(),
  o: () => z.looseObject({}),
  a: () => z.array(z.unknown()),
  u: () => z.unknown(),
};

/** What the fields that many tools share mean. */
const FIELDS: Record<string, string> = {
  environment: "demo or live: the Trading 212 account read.",
  credentials: "Which accounts have API keys set.",
  writeEnabled: "Whether order tools are enabled on this server.",
  timestamp: "When the figures were read.",
  accountCurrency: "The account's currency; amounts are in it unless a field says otherwise.",
  currency: "The account's currency.",
  truncated: "History was cut short at the page limit, so older records are not counted.",
  period: "The window the figures cover.",
  token: "One-time confirmation token for the matching app_execute_* tool.",
  expiresAt: "When the token expires.",
  ok: "Whether Trading 212 accepted it.",
  status: "What became of it; when unknown, never send it again before checking.",
  message: "What happened, in words.",
  legs: "The orders, each with its draft and checks.",
  notes: "Notes on what the figures leave out or assume.",
  policy: "The order policy and its checks.",
  account: "The account summary: value, cash and investments.",
  positions: "The holdings.",
  orders: "Open orders.",
  draft: "The order or change as drafted, for the user to review.",
};

function payload(kinds: string, fields: string) {
  const kind = kinds.split("|");
  return z.looseObject({
    kind: z.string().describe(`The payload: ${kind.join(" or ")}.`),
    ...Object.fromEntries(fields.split(" ").filter(Boolean).map((field) => {
      const [name, type] = field.split(":") as [string, FieldType];
      const schema = TYPES[type]().nullish();
      return [name, FIELDS[name] ? schema.describe(FIELDS[name]) : schema];
    })),
  });
}

const drafted = "environment:s purpose:s title:s legs:a notes:a credentials:o writeEnabled:b";
const dashboard = "appName:s environment:s credentials:o account:o positions:a orders:a activity:a timestamp:s writeEnabled:b";
const holding = "environment:s credentials:o ticker:s instrument:o accountCurrency:s accountRate:n position:o watching:o weight:n orders:a alerts:a journal:a market:o history:o prices:o day:o timestamp:s writeEnabled:b";
const pies = "environment:s credentials:o timestamp:s pies:a totals:o currency:s notes:a writeEnabled:b";
const plan = "environment:s credentials:o candidates:a account:o timestamp:s writeEnabled:b";
const automation = "environment:s credentials:o plans:a alerts:a accountAlerts:a links:a instruments:a usageToday:o currency:s account:o policy:o settings:o timestamp:s writeEnabled:b";
// What the broker sent back, as it sent it.
const execution = "environment:s ok:b status:s order:u message:s";

/** Each tool's structured content, by tool name. */
export const TOOL_OUTPUT: Record<string, ReturnType<typeof payload>> = {
  analyze_portfolio_allocation: payload("allocation", "environment:s accountCurrency:s totalValue:n investedValue:n cash:n availableCash:n cashWeight:n holdings:a byCurrency:a byType:a concentration:o flags:a drift:o risk:o fxFeeRate:n timestamp:s credentials:o writeEnabled:b"),
  app_execute_basket: payload("basket_execution", "environment:s purpose:s ok:b status:s legs:a message:s"),
  app_execute_cancel: payload("order_execution", execution),
  app_execute_order: payload("order_execution", `${execution} verificationId:s`),
  app_execute_pie_change: payload("pie_change_result", "environment:s action:s ok:b status:s pieId:n pie:u message:s"),
  app_get_automation: payload("automation", automation),
  app_get_dashboard: payload("portfolio", dashboard),
  app_get_holding: payload("holding", holding),
  app_get_holding_covariance: payload("holding_covariance", "environment:s covariance:o weeks:n to:s"),
  app_get_today: payload("portfolio_today", "environment:s accountCurrency:s moves:a total:o invested:n timestamp:s"),
  app_get_trade_plan: payload("trade_plan", plan),
  app_list_pies: payload("pies", pies),
  app_prepare_basket: payload("basket_preview", "token:s expiresAt:s snapshotAt:s environment:s purpose:s title:s accountCurrency:s legs:a notes:a"),
  app_prepare_cancel: payload("cancel_preview", "token:s expiresAt:s environment:s orderId:s order:o"),
  app_prepare_order: payload("order_preview", "token:s expiresAt:s snapshotAt:s draft:o instrument:o estimatedNotional:n estimatedNotionalCurrency:s estimatedAccountNotional:n accountCurrency:s availableCash:n availableToSell:n notices:a policy:a warnings:a"),
  app_prepare_pie_change: payload("pie_change_preview", "token:s expiresAt:s environment:s action:s pieId:n request:o current:o changes:a notices:a"),
  app_verify_unknown_execution: payload("execution_verification", "verificationId:s environment:s operation:s status:s message:s"),
  get_automation_overview: payload("automation", automation),
  get_cash_history: payload("cash_history", "environment:s items:a count:n totals:o currency:s truncated:b timestamp:s"),
  get_holding_detail: payload("holding", holding),
  get_income_summary: payload("income", "environment:s accountCurrency:s period:o total:n dividends:n interest:n byMonth:a byTicker:a trailing12Months:n forwardAnnual:o truncated:b timestamp:s credentials:o writeEnabled:b"),
  get_journal_review: payload("journal_review", "environment:s accountCurrency:s period:o fills:n withNote:n overall:o tags:a reviewed:n due:n trades:a tradesTotal:n unmatched:n withoutOrder:n unpriced:a notQuoted:a truncated:b timestamp:s credentials:o writeEnabled:b"),
  get_market_hours: payload("market_status", "environment:s ticker:s exchange:s session:s isOpen:b nextOpen:s nextClose:s checkedAt:s"),
  get_order_status: payload("order_status", "environment:s orderId:s state:s order:o fills:a timestamp:s"),
  get_pie: payload("pies", pies),
  get_portfolio_dashboard: payload("portfolio", dashboard),
  get_portfolio_performance: payload("performance", "environment:s accountCurrency:s period:o coverage:o contributions:o income:o costs:o realizedProfitLoss:n unrealizedProfitLoss:n currentValue:n simpleReturn:n annualizedReturn:n timeWeighted:o benchmark:o valueHistory:a trades:o byTicker:a notes:a timestamp:s credentials:o writeEnabled:b"),
  get_portfolio_today: payload("portfolio", `${dashboard} today:o`),
  get_quote: payload("quote", "environment:s instrument:o price:n asOf:s source:s"),
  get_recent_trading_activity: payload("activity", "environment:s activity:a"),
  get_tax_year_summary: payload("tax_year", "environment:s accountCurrency:s year:n yearStart:s timeZone:s firstDay:s lastDay:s period:o ended:b disposals:o byTicker:a income:o costs:o truncated:b notes:a timestamp:s"),
  get_trade_history: payload("trade_history", "environment:s fills:a unfilled:a journal:a truncated:b timestamp:s"),
  get_trading_policy: payload("trading_policy", "environment:s policy:o maxOrderNotional:n maxOrderQuantity:n usageToday:o demoAutomationEnabled:b"),
  get_watchlist: payload("watchlist", "environment:s accountCurrency:s items:a timestamp:s credentials:o writeEnabled:b"),
  list_investment_plans: payload("investment_plans", "plans:a demoAutomationEnabled:b"),
  list_pies: payload("pies", pies),
  list_price_alerts: payload("price_alerts", "alerts:a accountAlerts:a webhook:b"),
  manage_account_alerts: payload("account_alert", "alert:o deleted:u"),
  manage_history_export: payload("history_export", "environment:s reports:a requested:o report:o summary:o records:a recordCount:n"),
  manage_investment_plans: payload("investment_plan", "plan:o deleted:u"),
  manage_price_alerts: payload("price_alert", "alert:o deleted:u"),
  manage_target_allocation: payload("target_allocation", "environment:s"),
  manage_trade_journal: payload("trade_journal|journal_entry", "environment:s entries:a total:n entry:o deleted:u"),
  manage_watchlist: payload("watchlist_change", "environment:s action:s item:o added:b"),
  plan_portfolio_rebalance: payload("basket_draft", `${drafted} rebalance:o`),
  review_investment_plan: payload("basket_draft", drafted),
  review_order_basket: payload("basket_draft", drafted),
  review_order_cancel: payload("cancel_draft", "environment:s orderId:s order:o credentials:o writeEnabled:b"),
  review_pie_change: payload("pie_change_draft", "draft:o current:o credentials:o writeEnabled:b"),
  review_portfolio_stops: payload("basket_draft", drafted),
  review_protective_orders: payload("basket_draft", drafted),
  review_trading212_order: payload("order_draft", "draft:o resolvedInstrument:o credentials:o writeEnabled:b"),
  review_trading212_order_intent: payload("order_draft", "draft:o resolvedInstrument:o resolution:o note:s credentials:o writeEnabled:b"),
  search_trading212_instruments: payload("instrument_search", "environment:s query:s instruments:a credentials:o"),
  show_daily_trade_plan: payload("trade_plan", plan),
};
