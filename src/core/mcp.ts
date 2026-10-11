import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import { MAX_BASKET_LEGS, resolveInstrumentFromList } from "./trading-service.js";
import { DEFAULT_HISTORY_PAGES, MAX_HISTORY_PAGES, parseWindow } from "./insights-service.js";
import { MAX_LIMIT_OFFSET_PERCENT, MAX_PLAN_LEGS } from "./automation.js";
import { MAX_PIE_INSTRUMENTS } from "./pies.js";
import type { PieChangeDraft } from "../shared/pies.js";
import type { Services } from "../app/services.js";
import type { CancelDraftPayload, OrderDraft, OrderIntent, TradeCandidate } from "../shared/contracts.js";
import { APP_META } from "../shared/meta.js";
import { asStructuredError } from "./errors.js";
import { describePayload, num } from "./text-summary.js";

const WIDGET_URI = "ui://tradepilot212/trading-dashboard.html";

const SAMPLE_INSTRUCTIONS = "TradePilot is running on sample data (TRADEPILOT_SAMPLE_DATA): the Demo account is simulated and Live is off. Every balance, holding and order here is made up for trying the app; say so when you report numbers, and nothing reaches Trading 212.";

// Hosts that render the widget confirm there. In a text-only host the app_* tools are the same two
// steps, and the host's own per-call permission prompt sits in front of each one.
const ORDER_INSTRUCTIONS = [
  "Orders: review_* tools and plan_portfolio_rebalance only draft; they never send anything.",
  "Where the TradePilot widget is shown, the user edits and confirms there; do not call app_* tools yourself.",
  "Where it is not shown (a terminal or another text-only host), show the user the draft from the tool's text.",
  "If they want it sent, call the matching app_prepare_* tool to validate it (this sends nothing), show them its summary with the amount, notes and policy checks,",
  "and call app_execute_* with that token only after they explicitly confirm in this conversation. For Live, pass liveAcknowledged=true only after they confirm they understand real money is used.",
  "Never resend an order whose result is unknown; check it with app_verify_unknown_execution.",
].join(" ");

/** The text carries the payload's facts too, for hosts that show the model only text. */
function result(data: unknown, text: string) {
  const detail = describePayload(data);
  return {
    content: [{ type: "text" as const, text: detail ? `${text}\n\n${detail}` : text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const structured = asStructuredError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: structured.message }],
    structuredContent: { kind: "error", message: structured.message, error: structured },
  };
}

const environmentEnum = z.enum(["demo", "live"]);
const candidateSchema = z.object({
  ticker: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  horizon: z.enum(["short", "medium", "long"]),
  action: z.enum(["buy", "sell", "watch"]),
  score: z.number().min(0).max(100),
  rationale: z.string().min(1).max(3000),
  risk: z.enum(["low", "medium", "high"]),
  suggestedQuantity: z.number().positive().optional(),
  referencePrice: z.number().positive().optional(),
  referencePriceAt: z.string().datetime().optional(),
  analysisAsOf: z.string().datetime().optional(),
  thesis: z.string().min(1).max(3000).optional(),
  catalysts: z.array(z.string().min(1).max(500)).max(12).optional(),
  risks: z.array(z.string().min(1).max(500)).max(12).optional(),
  counterCase: z.string().min(1).max(3000).optional(),
  sources: z.array(z.string().min(1).max(500)).max(12).optional(),
});

const fxRateSchema = z.number().positive().optional()
  .describe("Instrument-currency units per 1 account-currency unit, with fxRateAt from a dated source. Needed only for an instrument quoted in a currency none of your holdings use, so the order's value can be checked against MAX_ORDER_NOTIONAL.");

const orderDraftSchema = z.object({
  environment: environmentEnum,
  ticker: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit", "stop", "stop_limit"]),
  quantity: z.number().positive(),
  extendedHours: z.boolean().optional(),
  timeValidity: z.enum(["DAY", "GOOD_TILL_CANCEL"]).optional(),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  referencePrice: z.number().positive().optional(),
  referencePriceAt: z.string().datetime().optional(),
  fxRate: fxRateSchema,
  fxRateAt: z.string().datetime().optional(),
});

const orderSizingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("quantity"), quantity: z.number().positive() }),
  z.object({
    mode: z.literal("notional"),
    amount: z.number().positive(),
    currency: z.string().min(3).max(8).optional(),
    fxRateToInstrumentCurrency: z.number().positive().optional(),
  }),
  z.object({ mode: z.literal("cash_percent"), percent: z.number().positive().max(100), fxRateToInstrumentCurrency: z.number().positive().optional() }),
  z.object({ mode: z.literal("position_percent"), percent: z.number().positive().max(100) }),
  z.object({ mode: z.literal("all_available") }),
]);

const dateOrDateTime = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)) && /T/.test(value), "Use YYYY-MM-DD or an ISO date-time");
const windowSchema = {
  period: z.enum(["1w", "1m", "3m", "ytd", "1y", "all"]).default("all").describe("Shortcut window ending now. Ignored when from is given."),
  from: dateOrDateTime.optional().describe("Start: YYYY-MM-DD (start of that UTC day) or an ISO date-time"),
  to: dateOrDateTime.optional().describe("End: YYYY-MM-DD (end of that UTC day) or an ISO date-time"),
  maxPages: z.number().int().min(1).max(MAX_HISTORY_PAGES).default(DEFAULT_HISTORY_PAGES)
    .describe("History pages of 50 records to read per data set. Trading 212 allows about 20 history requests per minute."),
};

export function createMcpServer(
  { trading, insights, automation, alerts, pies, automationOverview }: Services,
  config: RuntimeConfig,
  widgetHtml: () => Promise<string>,
  scopes: ReadonlySet<string> = new Set(["trade:read", "trade:write"]),
): McpServer {
  const canWrite = scopes.has("trade:write");
  const environmentWithDefault = environmentEnum.default(config.defaultTradingEnvironment);
  const instructions = [
    config.sampleData ? SAMPLE_INSTRUCTIONS : "",
    canWrite ? ORDER_INSTRUCTIONS : "",
  ].filter(Boolean).join("\n\n");
  const server = new McpServer({ name: "tradepilot212", version: APP_META.version }, instructions ? { instructions } : {});

  registerAppResource(
    server,
    "TradePilot 212 trading dashboard",
    WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await widgetHtml(),
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "get_portfolio_dashboard",
    {
      title: "Trading 212 Portfolio Dashboard",
      description:
        "Read the user's Trading 212 Invest account summary, positions and pending orders and render the interactive dashboard. Respect an explicitly requested Demo/Live environment; otherwise use this TradePilot instance's configured default environment.",
      inputSchema: z.object({ environment: environmentWithDefault }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment }) => {
      try {
        const data = { ...(await trading.getDashboard(environment)), writeEnabled: canWrite };
        return result(data, `Rendered ${environment.toUpperCase()} Trading 212 portfolio dashboard.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "search_trading212_instruments",
    {
      title: "Search Trading 212 Instruments",
      description:
        "Resolve a stock ticker, symbol, company name, or partial name to Trading 212 instruments. Read-only. Use this whenever the user's code/name is ambiguous or you need the broker's exact ticker.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {},
    },
    async ({ environment, query, limit }) => {
      try {
        const instruments = await trading.searchInstruments(environment, query, limit);
        const configured = credentialStatus(config)[environment];
        return result(
          { kind: "instrument_search", environment, query, credentials: credentialStatus(config), instruments },
          !configured
            ? `${environment.toUpperCase()} credentials are not configured, so instruments cannot be searched.`
            : instruments.length ? `Found ${instruments.length} Trading 212 instrument match(es) for "${query}".` : `No Trading 212 instrument matches "${query}".`,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

  registerAppTool(
    server,
    "analyze_portfolio_allocation",
    {
      title: "Portfolio Allocation Analysis",
      description:
        "Compute exact portfolio weights, cash share, currency and asset-type exposure, concentration (largest holding, top 5, Herfindahl, effective number of holdings) and rule-based flags. Use this instead of estimating weights yourself. Read-only.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        maxSingleWeight: z.number().gt(0).max(1).optional().describe("Flag a single holding above this share of invested value. Default 0.2."),
        maxTop5Weight: z.number().gt(0).max(1).optional(),
        cashHighWeight: z.number().gt(0).max(1).optional(),
        cashLowWeight: z.number().min(0).max(1).optional(),
      }),
      annotations: readOnly,
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, ...limits }) => {
      try {
        const data = { ...(await insights.allocation(environment, limits)), credentials: credentialStatus(config), writeEnabled: canWrite };
        return result(data, `Allocation: ${data.holdings.length} holdings, cash ${(data.cashWeight * 100).toFixed(1)}%, largest ${(data.concentration.largestWeight * 100).toFixed(1)}% of invested value, ${data.flags.length} flag(s).`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_portfolio_performance",
    {
      title: "Portfolio Performance",
      description:
        "Summarize realized P/L, unrealized P/L, deposits and withdrawals, dividend and interest income, trading costs (commissions, FX fees, stamp duty and other taxes), trade counts and per-ticker contribution from Trading 212 history. All-time windows also include a simple return on net contributions. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, ...windowSchema }),
      annotations: readOnly,
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, period, from, to, maxPages }) => {
      try {
        const data = { credentials: credentialStatus(config), writeEnabled: canWrite, ...await insights.performance(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), maxPages) };
        return result(data, `Realized P/L ${num(data.realizedProfitLoss)} ${data.accountCurrency}, income ${num(data.income.dividends + data.income.interest)} ${data.accountCurrency}, costs ${num(data.costs.total)} ${data.accountCurrency}${data.coverage.truncated ? " (history truncated)" : ""}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_income_summary",
    {
      title: "Dividend and Interest Income",
      description: "Summarize dividend and cash-interest income by month and by ticker, plus trailing-12-month income. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, ...windowSchema }),
      annotations: readOnly,
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, period, from, to, maxPages }) => {
      try {
        const data = { credentials: credentialStatus(config), writeEnabled: canWrite, ...await insights.income(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), maxPages) };
        return result(data, `Income ${data.total} ${data.accountCurrency} in the selected period; trailing 12 months ${data.trailing12Months}.${data.forwardAnnual ? ` Expected next 12 months from current holdings: ${data.forwardAnnual.total}${data.forwardAnnual.yieldOnValue === null ? "" : ` (${(data.forwardAnnual.yieldOnValue * 100).toFixed(2)}% of invested value)`}.` : ""}`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_trade_history",
    {
      title: "Trade History",
      description: "List executed fills with price, quantity, net value, realized P/L, FX rate and costs, newest first. Optionally filter by ticker, symbol, name or ISIN (filtered by Trading 212, so older trades of one instrument are found), and include orders that closed without a fill (cancelled, rejected, expired). Read-only.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        ticker: z.string().min(1).optional(),
        includeUnfilled: z.boolean().default(false).describe("Also list orders that were cancelled, rejected or expired without a fill"),
        limit: z.number().int().min(1).max(200).default(50),
        ...windowSchema,
      }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment, ticker, includeUnfilled, limit, period, from, to, maxPages }) => {
      try {
        const data = await insights.tradeHistory(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), ticker, limit, maxPages, includeUnfilled);
        return result(data, `Returned ${data.fills.length} fills${data.unfilled ? ` and ${data.unfilled.length} unfilled order(s)` : ""}${data.truncated ? " (history truncated)" : ""}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_cash_history",
    {
      title: "Dividends and Cash Movements",
      description: "List dividends, deposits, withdrawals, interest and fees one by one, newest first, with totals per type, from Trading 212 history. Filter by type (DIVIDEND, DEPOSIT, WITHDRAW, INTEREST, FEE …) or by an instrument for its dividends. Use get_income_summary for monthly totals and yields. Read-only.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        ticker: z.string().min(1).optional().describe("Only dividends of this ticker, symbol, name or ISIN"),
        types: z.array(z.string().min(1).max(30)).max(10).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        ...windowSchema,
      }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment, ticker, types, limit, period, from, to, maxPages }) => {
      try {
        const data = await insights.cashHistory(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), { ...(ticker ? { ticker } : {}), ...(types ? { types } : {}), limit, ...(maxPages ? { maxPages } : {}) });
        return result(data, `Returned ${data.items.length} of ${data.count} entries${data.truncated ? " (history truncated)" : ""}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_order_status",
    {
      title: "Order Status",
      description: "Look up one Trading 212 order by id: still open (and how much filled), or how it ended (filled, partly filled, cancelled, rejected) with its fills and prices. Reads open orders, then recent history. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, orderId: z.string().min(1).max(24) }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment, orderId }) => {
      try {
        const data = await trading.orderStatus(environment, orderId);
        return result(data, `Order ${data.orderId}: ${data.state.replace("_", " ")}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_market_hours",
    {
      title: "Market Hours",
      description: "Report whether an instrument's market is in its regular, pre-market, after-hours or overnight session or closed, with the next open and close times from Trading 212's exchange schedules. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, instrument: z.string().min(1) }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment, instrument }) => {
      try {
        const data = await insights.marketHours(environment, instrument);
        return result({ kind: "market_status", environment, ...data }, `${data.ticker}: ${data.session}${data.nextOpen ? `, next open ${data.nextOpen}` : ""}${data.nextClose ? `, next close ${data.nextClose}` : ""}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "manage_history_export",
    {
      title: "Trading 212 CSV Export",
      description:
        "List Trading 212 CSV history reports with their download links, or request a new report for a period (orders, dividends, interest and transactions). Requesting a report does not trade; the broker builds it asynchronously, so list again later for the link.",
      inputSchema: z.object({ environment: environmentWithDefault, action: z.enum(["list", "request"]).default("list"), ...windowSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: {},
    },
    async ({ environment, action, period, from, to }) => {
      try {
        if (action === "request") {
          // Requesting a report is a broker write, so it needs the same write access as orders.
          if (!canWrite) return toolError(new Error("Requesting a new export needs order tools enabled (trade:write). Listing existing reports works without it."));
          const window = parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) });
          const created = await insights.requestExport(environment, window);
          const covered = window.from ? "" : " Without a start date the report covers the last 365 days.";
          return result({ kind: "history_export", environment, requested: created }, `Requested report ${created.reportId}.${covered} List exports again in a minute for the download link.`);
        }
        const reports = await insights.listExports(environment);
        return result({ kind: "history_export", environment, reports }, `Found ${reports.length} report(s).`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_recent_trading_activity",
    {
      title: "Recent Trading Activity",
      description: "Read recent TradePilot order/cancellation lifecycle events for the selected environment. This is an audit trail only and never submits or changes an order.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        limit: z.number().int().min(1).max(50).default(12),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {},
    },
    async ({ environment, limit }) => {
      try {
        const activity = await trading.getActivity(environment, limit);
        return result({ kind: "activity", environment, activity }, `Returned ${activity.length} recent TradePilot activity events.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "show_daily_trade_plan",
    {
      title: "Trading 212 Daily Trade Plan",
      description:
        "Render supplied stock candidates as actionable short (<=1 week), medium (<=1 month), and long (>=1 year) cards. This tool never places orders. Include a current referencePrice for actionable Market-order candidates whenever possible, especially when the app-level notional cap is enabled.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        candidates: z.array(candidateSchema).min(1).max(30),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, candidates }) => {
      try {
        const data = { ...(await trading.getTradePlan(environment, candidates as TradeCandidate[])), writeEnabled: canWrite };
        return result(
          data,
          `Rendered ${candidates.length} candidates. No trade has been placed; execution is only available after explicit user confirmation in the widget.`,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (canWrite) {
    registerAppTool(
      server,
      "review_trading212_order_intent",
      {
        title: "Review Flexible Trading 212 Order",
        description:
          "Preferred order-entry tool for natural-language requests. Accept a stock ticker, symbol, or company name and resolve it to Trading 212. Supports exact quantity, a target monetary amount, buying with a percentage of available cash, selling a percentage of the total held position (when that quantity is tradable), or selling all currently available shares. This tool is review-only: it reads current account/position data, computes an editable standard quantity order, and opens the confirmation UI; it never submits an order. For notional sizing, provide a current referencePrice. If the requested amount currency differs from the instrument quote currency, also provide fxRateToInstrumentCurrency (instrument-currency units per 1 requested-currency unit). While MAX_ORDER_NOTIONAL is on, an instrument quoted in a currency none of the holdings use needs fxRate (or fxRateToInstrumentCurrency from the account currency) so its value can be checked against the cap. Examples: 'buy about €100 of NVDA' => notional sizing; 'use 20% of my available cash to buy Apple' => cash_percent 20; 'sell half my Apple' => position_percent 50 of the held position; 'sell all NVDA' => all_available.",
        inputSchema: z.object({
          environment: environmentWithDefault,
          instrument: z.string().min(1).describe("Trading 212 ticker, market symbol, company name, or partial name"),
          side: z.enum(["buy", "sell"]),
          type: z.enum(["market", "limit", "stop", "stop_limit"]).default("market"),
          sizing: orderSizingSchema,
          extendedHours: z.boolean().optional(),
          timeValidity: z.enum(["DAY", "GOOD_TILL_CANCEL"]).optional(),
          limitPrice: z.number().positive().optional(),
          stopPrice: z.number().positive().optional(),
          referencePrice: z.number().positive().optional(),
          referencePriceAt: z.string().datetime().optional(),
          fxRate: fxRateSchema,
          fxRateAt: z.string().datetime().optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async (intent) => {
        try {
          const resolved = await trading.resolveOrderIntent(intent as OrderIntent);
          return result(
            {
              kind: "order_draft",
              draft: resolved.draft,
              resolvedInstrument: resolved.instrument,
              resolution: {
                sizing: resolved.sizing,
                resolvedQuantity: resolved.draft.quantity,
                ...(resolved.accountCurrency ? { accountCurrency: resolved.accountCurrency } : {}),
                ...(resolved.heldQuantity === undefined ? {} : { heldQuantity: resolved.heldQuantity }),
                ...(resolved.availableToSell === undefined ? {} : { availableToSell: resolved.availableToSell }),
                ...(resolved.requestedNotional === undefined ? {} : { requestedNotional: resolved.requestedNotional }),
                ...(resolved.requestedNotionalCurrency ? { requestedNotionalCurrency: resolved.requestedNotionalCurrency } : {}),
                ...(resolved.estimatedQuoteNotional === undefined ? {} : { estimatedQuoteNotional: resolved.estimatedQuoteNotional }),
              },
              note: resolved.note,
              credentials: credentialStatus(config),
              writeEnabled: true,
            },
            `${resolved.note} Opened an editable order draft. No order has been submitted.`,
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "review_trading212_order",
      {
        title: "Review Exact Trading 212 Order",
        description:
          "Advanced exact-order entry. Open an editable order draft when the exact Trading 212 ticker and quantity are already known. This is review-only and never places an order. Prefer review_trading212_order_intent for natural-language sizing such as money amounts, half, percentages, or all shares.",
        inputSchema: orderDraftSchema.extend({ environment: environmentWithDefault }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async (draft) => {
        try {
          const instrument = resolveInstrumentFromList(await trading.instruments(draft.environment), draft.ticker);
          return result(
            { kind: "order_draft", draft: { ...draft, ticker: instrument.ticker } as OrderDraft, resolvedInstrument: instrument, credentials: credentialStatus(config), writeEnabled: true },
            "Order draft opened for human review. No order has been submitted.",
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  registerAppTool(
    server,
    "get_trading_policy",
    {
      title: "Trading Policy",
      description: "Show the trading rules this TradePilot instance enforces for an environment (position-weight cap, daily order and value budgets, ticker and type lists, closed-market Market orders, reference-price age, per-order caps) and how much of today's budget is used. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment }) => {
      try {
        const usage = await trading.usageToday(environment);
        const data = { kind: "trading_policy", environment, policy: config.policy[environment], maxOrderNotional: config.maxOrderNotional, maxOrderQuantity: config.maxOrderQuantity, usageToday: usage, demoAutomationEnabled: config.demoAutomationEnabled };
        return result(data, `${environment.toUpperCase()} policy loaded; ${usage.orders} order(s) sent through TradePilot today.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "plan_portfolio_rebalance",
    {
      title: "Plan a Rebalance",
      description:
        "Compute the sells and buys that move the account toward target weights (shares of total account value), using the broker's position prices, the cash on hand and an optional cash reserve. Sells fund buys; buys are scaled down when cash is short. This never places orders: with order tools enabled it opens the trades as one basket for the user to review and confirm. Instruments you do not hold are priced from the external quote provider when it can map them; otherwise pass a referencePrice, because Trading 212 has no quote endpoint.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        targets: z.array(z.object({
          ticker: z.string().min(1).describe("Trading 212 ticker, symbol or name"),
          weight: z.number().min(0).max(1),
          referencePrice: z.number().positive().optional(),
          referencePriceAt: z.string().datetime().optional().describe("When referencePrice is from"),
        })).min(1).max(MAX_BASKET_LEGS),
        cashWeight: z.number().min(0).max(1).default(0).describe("Share of total value to keep in cash"),
        minTradeValue: z.number().min(0).default(1).describe("Skip trades smaller than this, in the account currency"),
        sellUntargeted: z.boolean().default(false).describe("Sell holdings that have no target"),
        wholeSharesOnly: z.boolean().default(false),
        fxRates: z.record(z.string(), z.number().positive()).optional().describe("Instrument-currency units per 1 account-currency unit, e.g. {\"USD\": 1.08} for a EUR account. Optional: by default each rate comes from the broker's valuation of a holding in that currency"),
      }),
      annotations: readOnly,
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, targets, cashWeight, minTradeValue, sellUntargeted, wholeSharesOnly, fxRates }) => {
      try {
        const plan = await trading.planRebalance(environment, targets, { cashWeight, minTradeValue, sellUntargeted, quantityDecimals: wholeSharesOnly ? 0 : 4, ...(fxRates ? { fxRates } : {}) });
        const data = { ...(await trading.withInstruments(trading.rebalanceBasket(plan))), rebalance: plan, credentials: credentialStatus(config), writeEnabled: canWrite };
        return result(data, `Rebalance plan: ${plan.trades.length} trade(s)${plan.skipped.length ? `, ${plan.skipped.length} target(s) skipped` : ""}. Nothing has been sent${canWrite ? "; the user reviews and confirms the basket before anything is sent" : ""}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_investment_plans",
    {
      title: "Investment Plans",
      description: "List standing dollar-cost-averaging plans with their schedule, legs, next due time, last outcome and whether Demo plans run unattended. Read-only.",
      inputSchema: z.object({ environment: environmentEnum.optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {},
    },
    async ({ environment }) => {
      try {
        const plans = await automation.listPlans(environment);
        return result({ kind: "investment_plans", plans, demoAutomationEnabled: config.demoAutomationEnabled }, `${plans.length} plan(s).`);
      } catch (error) {
        return toolError(error);
      }
    },
  );


  const pieDraftSchema = z.object({
    environment: environmentWithDefault,
    action: z.enum(["create", "update", "delete", "duplicate"]),
    pieId: z.number().int().positive().optional().describe("Required for update, delete and duplicate"),
    name: z.string().min(1).max(100).optional(),
    icon: z.string().max(40).optional(),
    goal: z.number().positive().optional().describe("Target value in the account currency"),
    endDate: z.string().datetime().optional(),
    dividendCashAction: z.enum(["REINVEST", "TO_ACCOUNT_CASH"]).optional(),
    instrumentShares: z.record(z.string(), z.number().positive()).optional()
      .describe(`Ticker, symbol or name to target share, up to ${MAX_PIE_INSTRUMENTS}. Shares are normalised to sum to 1, so {"VUSA": 70, "EIMI": 30} works. On update, omit to keep the current slices.`),
  });

  registerAppTool(
    server,
    "list_pies",
    {
      title: "Trading 212 Pies",
      description: "List the user's Trading 212 pies with value, invested amount, return, dividends, goal progress and, for the newest pies, each slice's target and current share and the drift between them. Read-only. Trading 212 allows one pie list read every 30 seconds and one detail read every 5 seconds, so results are cached briefly.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        details: z.number().int().min(0).max(30).default(10).describe("How many pies to read slices for, newest first"),
        fresh: z.boolean().default(false).describe("Skip the short cache"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, details, fresh }) => {
      try {
        const data = { ...(await pies.listPies(environment, { details, fresh })), writeEnabled: canWrite };
        return result(data, `${data.pies.length} ${environment.toUpperCase()} pie(s).`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_pie",
    {
      title: "Trading 212 Pie",
      description: "Read one pie with its settings, every slice's target and current share, owned quantity, value, return and any issues Trading 212 reports. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, pieId: z.number().int().positive() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, pieId }) => {
      try {
        const pie = await pies.getPie(environment, pieId);
        const data = { kind: "pies", environment, credentials: credentialStatus(config), writeEnabled: canWrite, pies: [pie], totals: { value: pie.value, invested: pie.invested, result: pie.result, cash: pie.cash }, notes: [], timestamp: new Date().toISOString() };
        return result(data, `${pie.name}: ${pie.instruments?.length ?? 0} slice(s).`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_automation_overview",
    {
      title: "Automation Overview",
      description: "Show everything TradePilot runs on its own for an environment, in the widget: investment plans with their next due time and last outcome, price alerts with the last price seen, linked stop-loss / take-profit pairs, today's order and value usage against the policy, and which automation settings are on (Demo automation, linking, webhook, daily digest, quote source). Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment }) => {
      try {
        const data = { ...(await automationOverview(environment)), writeEnabled: canWrite };
        return result(data, `${environment.toUpperCase()}: ${data.plans.length} plan(s), ${data.alerts.length} alert(s), ${data.links.length} linked pair(s); ${data.usageToday.orders} order(s) sent today.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_quote",
    {
      title: "Instrument Price",
      description: "Get the best available price for a Trading 212 instrument: the broker's last price when it is held, otherwise the configured external quote provider (Stooq by default, free and unofficial; Finnhub, Twelve Data or Alpha Vantage with QUOTE_API_KEY). Use it to fill referencePrice before drafting an order. Read-only.",
      inputSchema: z.object({ environment: environmentWithDefault, instrument: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {},
    },
    async ({ environment, instrument }) => {
      try {
        const lookup = await trading.lookupPrice(environment, instrument);
        const text = lookup.price === undefined
          ? `${lookup.instrument.ticker}: no price. ${lookup.message ?? ""}`.trim()
          : `${lookup.instrument.ticker}: ${lookup.price} ${lookup.instrument.currencyCode} from ${lookup.source}${lookup.symbol ? ` (${lookup.symbol})` : ""} as of ${lookup.asOf}.`;
        return result({ kind: "quote", environment, ...lookup }, text);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "list_price_alerts",
    {
      title: "Price Alerts",
      description: "List price alerts on holdings: the condition, the last price seen, and whether and when each one triggered. Read-only.",
      inputSchema: z.object({ environment: environmentEnum.optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {},
    },
    async ({ environment }) => {
      try {
        const list = await alerts.list(environment);
        return result({ kind: "price_alerts", alerts: list, webhook: !!config.notifyWebhookUrl }, `${list.length} alert(s), ${list.filter((alert) => alert.triggeredAt).length} triggered.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (canWrite) {
    registerAppTool(
      server,
      "review_pie_change",
      {
        title: "Review a Pie Change",
        description: "Draft creating, updating (name, slices, goal, end date, icon, dividend handling), duplicating or deleting a Trading 212 pie, and open it for the user to review and confirm. Never changes anything by itself. Creating a pie invests nothing.",
        inputSchema: pieDraftSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async (draft) => {
        try {
          if (draft.action !== "create" && !draft.pieId) return toolError(new Error(`pieId is required to ${draft.action} a pie; list_pies shows the ids.`));
          const current = draft.action === "create" || !draft.pieId ? undefined : await pies.getPie(draft.environment, draft.pieId);
          const data = { kind: "pie_change_draft", draft: draft as PieChangeDraft, ...(current ? { current } : {}), credentials: credentialStatus(config), writeEnabled: true };
          return result(data, `Opened a pie ${draft.action} for review. Nothing has been changed.`);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  // Alerts only notify; they never place orders, so they work without order tools.
  registerAppTool(
    server,
    "manage_price_alerts",
    {
      title: "Manage Price Alerts",
      description: "Create, delete or re-arm a price alert on a holding. Conditions: above or below a price; trailing_drop (falls a percent from the highest price seen, a trailing-stop style warning); gain_percent or loss_percent against the average cost. The scheduler checks alerts every minute against the broker's last position price, logs a triggered alert once and sends it to the notification webhook when one is configured. Alerts never place orders. Held instruments use the broker price; others use the external quote provider when one is configured (US tickers automatically, others via QUOTE_SYMBOLS). Gain and loss alerts need a holding.",
      inputSchema: z.object({
        action: z.enum(["create", "delete", "rearm"]),
        alertId: z.string().optional().describe("Required for delete and rearm"),
        environment: environmentWithDefault,
        instrument: z.string().min(1).optional(),
        condition: z.enum(["above", "below", "trailing_drop", "gain_percent", "loss_percent"]).optional(),
        price: z.number().positive().optional(),
        percent: z.number().positive().optional(),
        note: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: {},
    },
    async (input) => {
      try {
        if (input.action === "create") {
          if (!input.instrument || !input.condition) return toolError(new Error("instrument and condition are required to create an alert"));
          const alert = await alerts.create({
            environment: input.environment,
            instrument: input.instrument,
            condition: input.condition,
            ...(input.price === undefined ? {} : { price: input.price }),
            ...(input.percent === undefined ? {} : { percent: input.percent }),
            ...(input.note ? { note: input.note } : {}),
          });
          return result({ kind: "price_alert", alert }, `Saved alert ${alert.id} on ${alert.ticker}.${config.notifyWebhookUrl ? "" : " Set NOTIFY_WEBHOOK_URL to be told outside the chat."}`);
        }
        if (!input.alertId) return toolError(new Error("alertId is required"));
        if (input.action === "delete") {
          await alerts.delete(input.alertId);
          return result({ kind: "price_alert", deleted: input.alertId }, `Deleted alert ${input.alertId}.`);
        }
        const alert = await alerts.rearm(input.alertId);
        return result({ kind: "price_alert", alert }, `Re-armed alert ${alert.id}.`);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (canWrite) {
    registerAppTool(
      server,
      "manage_investment_plans",
      {
        title: "Manage Investment Plans",
        description:
          "Create, change, pause or delete a standing dollar-cost-averaging plan (for example 'buy 100 EUR of VUSA on the 1st of every month'). Saving a plan places no order. When a plan is due, Live plans and ordinary Demo plans wait for the user to confirm the basket (open it with review_investment_plan). Only Demo plans with autoExecute run unattended, and only when the server enables Demo automation. Amounts are in the account currency. Held legs are priced from the broker; legs not held yet from the external quote provider when it can map them. A leg can be a Market buy (default) or a Day Limit buy capped at the last price plus limitOffsetPercent.",
        inputSchema: z.object({
          action: z.enum(["create", "update", "delete"]),
          planId: z.string().optional().describe("Required for update and delete"),
          environment: environmentWithDefault,
          label: z.string().max(80).optional(),
          legs: z.array(z.object({
            ticker: z.string().min(1),
            amount: z.number().positive(),
            orderType: z.enum(["market", "limit"]).optional().describe("limit = Day Limit buy at the last price plus limitOffsetPercent, so a gap cannot fill it higher. Limit legs can also be placed while the market is closed."),
            limitOffsetPercent: z.number().min(0).max(MAX_LIMIT_OFFSET_PERCENT).optional().describe("Limit legs: percent above the last broker price (default 0.5)"),
          })).min(1).max(MAX_PLAN_LEGS).optional(),
          frequency: z.enum(["weekly", "monthly"]).optional(),
          dayOfMonth: z.number().int().min(1).max(28).optional(),
          weekday: z.number().int().min(1).max(7).optional().describe("1 = Monday … 7 = Sunday"),
          hourUtc: z.number().int().min(0).max(23).optional().describe("Hour (UTC) the plan becomes due. Default 15, inside the US and EU sessions."),
          autoExecute: z.boolean().optional().describe("Demo only: run unattended when due"),
          paused: z.boolean().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: {},
      },
      async (input) => {
        try {
          if (input.action === "create") {
            if (!input.legs || !input.frequency) return toolError(new Error("legs and frequency are required to create a plan"));
            const plan = await automation.createPlan({
              environment: input.environment,
              label: input.label ?? "DCA plan",
              legs: input.legs,
              frequency: input.frequency,
              ...(input.dayOfMonth === undefined ? {} : { dayOfMonth: input.dayOfMonth }),
              ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
              ...(input.hourUtc === undefined ? {} : { hourUtc: input.hourUtc }),
              ...(input.autoExecute === undefined ? {} : { autoExecute: input.autoExecute }),
            });
            const unattended = plan.autoExecute && !config.demoAutomationEnabled ? " Unattended runs also need AUTOMATION_DEMO_ENABLED=true on the server." : "";
            return result({ kind: "investment_plan", plan }, `Saved plan ${plan.id}; next due ${plan.nextRunAt}. No order was placed.${unattended}`);
          }
          if (!input.planId) return toolError(new Error("planId is required"));
          if (input.action === "delete") {
            await automation.deletePlan(input.planId);
            return result({ kind: "investment_plan", deleted: input.planId }, `Deleted plan ${input.planId}.`);
          }
          const plan = await automation.updatePlan(input.planId, {
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.legs === undefined ? {} : { legs: input.legs }),
            ...(input.paused === undefined ? {} : { paused: input.paused }),
            ...(input.autoExecute === undefined ? {} : { autoExecute: input.autoExecute }),
            ...(input.frequency === undefined ? {} : { frequency: input.frequency }),
            ...(input.dayOfMonth === undefined ? {} : { dayOfMonth: input.dayOfMonth }),
            ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
            ...(input.hourUtc === undefined ? {} : { hourUtc: input.hourUtc }),
          });
          return result({ kind: "investment_plan", plan }, `Updated plan ${plan.id}; next due ${plan.nextRunAt}.`);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "review_investment_plan",
      {
        title: "Review a Due Investment Plan",
        description: "Open a standing plan's orders as one basket for the user to review and confirm, sized from current broker prices. This never places an order.",
        inputSchema: z.object({ planId: z.string().min(1) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async ({ planId }) => {
        try {
          const data = { ...(await trading.withInstruments(await automation.reviewPlan(planId))), credentials: credentialStatus(config), writeEnabled: true };
          return result(data, `Opened ${data.legs.length} order(s) from plan "${data.title}" for review. Nothing has been sent.`);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "review_protective_orders",
      {
        title: "Review Stop-Loss and Take-Profit Orders",
        description: "Draft broker-native protective orders for a holding: a Stop sell below the current price (stop-loss) and/or a Limit sell above it (take-profit), both Good-Till-Cancel so Trading 212 triggers them. Opens them for review; never places an order. When both are placed, TradePilot links them: after one fills, the scheduler cancels the other.",
        inputSchema: z.object({
          environment: environmentWithDefault,
          instrument: z.string().min(1),
          stopLossPrice: z.number().positive().optional(),
          takeProfitPrice: z.number().positive().optional(),
          quantity: z.number().positive().optional().describe("Defaults to all tradable shares"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async ({ environment, instrument, ...input }) => {
        try {
          const data = { ...(await trading.withInstruments(await trading.protectiveBasket(environment, instrument, input))), credentials: credentialStatus(config), writeEnabled: true };
          return result(data, `Drafted ${data.legs.length} protective order(s) for review. Nothing has been sent.`);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "review_order_basket",
      {
        title: "Review an Order Basket",
        description: `Open up to ${MAX_BASKET_LEGS} exact orders as one basket that the user confirms once. Sells are sent before buys; an uncertain result stops the rest. Review-only; never places an order. Prefer plan_portfolio_rebalance for target weights.`,
        inputSchema: z.object({
          environment: environmentWithDefault,
          title: z.string().min(1).max(80).default("Order basket"),
          orders: z.array(orderDraftSchema.omit({ environment: true })).min(1).max(MAX_BASKET_LEGS),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async ({ environment, title, orders }) => {
        try {
          const basket = await trading.withInstruments({ environment, legs: orders.map((order) => ({ draft: { ...order, environment } as OrderDraft })) });
          return result(
            { kind: "basket_draft", environment, purpose: "custom", title, legs: basket.legs, notes: [], credentials: credentialStatus(config), writeEnabled: true },
            `Opened a basket of ${orders.length} order(s) for review. Nothing has been sent.`,
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "review_order_cancel",
      {
        title: "Review an Order Cancellation",
        description: "Open a pending order's cancellation for the user to confirm in the widget. Review-only; never cancels. Cancelling a stop-loss leaves the position unprotected, which the confirmation says.",
        inputSchema: z.object({ environment: environmentWithDefault, orderId: z.string().min(1).max(24) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async ({ environment, orderId }) => {
        try {
          const order = await trading.openOrder(environment, orderId);
          return result(
            { kind: "cancel_draft", environment, orderId: orderId.trim(), ...(order ? { order } : {}), credentials: credentialStatus(config), writeEnabled: true } satisfies CancelDraftPayload,
            order ? "Cancellation opened for review. Nothing has been cancelled." : `Order ${orderId} is not open any more; use get_order_status to see how it ended.`,
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  // App-only tools: hidden from the model. The widget invokes these only after explicit user actions.
  registerAppTool(
    server,
    "app_get_dashboard",
    {
      title: "Refresh dashboard",
      description: "App-only dashboard refresh.",
      inputSchema: z.object({ environment: environmentEnum }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ environment }) => {
      try {
        const data = { ...(await trading.getDashboard(environment)), writeEnabled: canWrite };
        return result(data, "Dashboard refreshed.");
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_get_automation",
    {
      title: "Refresh automation",
      description: "App-only automation overview refresh.",
      inputSchema: z.object({ environment: environmentEnum }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ environment }) => {
      try {
        return result({ ...(await automationOverview(environment)), writeEnabled: canWrite }, "Automation refreshed.");
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_list_pies",
    {
      title: "Refresh pies",
      description: "App-only pie list refresh.",
      inputSchema: z.object({ environment: environmentEnum, fresh: z.boolean().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ environment, fresh }) => {
      try {
        const data = { ...(await pies.listPies(environment, { fresh: fresh === true })), writeEnabled: canWrite };
        return result(data, "Pies refreshed.");
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "app_get_trade_plan",
    {
      title: "Refresh trade plan",
      description: "App-only trade plan refresh when the user switches Demo/Live.",
      inputSchema: z.object({ environment: environmentEnum, candidates: z.array(candidateSchema).min(1).max(30) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ environment, candidates }) => {
      try {
        const data = { ...(await trading.getTradePlan(environment, candidates as TradeCandidate[])), writeEnabled: canWrite };
        return result(data, "Trade plan refreshed.");
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (canWrite) {
    registerAppTool(
      server,
      "app_prepare_order",
      {
        title: "Prepare order confirmation",
        description: "App-only validation. Creates a short-lived one-time confirmation token; does not place an order.",
        inputSchema: orderDraftSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async (draft) => {
        try {
          const data = await trading.prepareOrder(draft as OrderDraft);
          return result(data, "Order validated. Explicit user confirmation is still required.");
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_execute_order",
      {
        title: "Execute confirmed order",
        description:
          "App-only destructive external write. Consumes a one-time token created by app_prepare_order. Never retry automatically.",
        inputSchema: z.object({ token: z.string().min(20), liveAcknowledged: z.boolean().optional().describe("Second confirmation that a Live write uses real money") }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token, liveAcknowledged }) => {
        try {
          const data = await trading.executeOrder(token, { liveAcknowledged: liveAcknowledged === true });
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_verify_unknown_execution",
      {
        title: "Verify uncertain execution",
        description: "App-only read-back verification after an ambiguous write result. This never retries the original order or cancellation.",
        inputSchema: z.object({ verificationId: z.string().min(1) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ verificationId }) => {
        try {
          const data = await trading.verifyExecution(verificationId);
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_prepare_cancel",
      {
        title: "Prepare order cancellation",
        description: "App-only cancellation validation; does not cancel yet.",
        inputSchema: z.object({ environment: environmentEnum, orderId: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ environment, orderId }) => {
        try {
          const data = await trading.prepareCancel(environment, orderId);
          return result(data, "Cancellation validated. Explicit confirmation is still required.");
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_execute_cancel",
      {
        title: "Execute confirmed cancellation",
        description: "App-only destructive write. Consumes a one-time cancellation token. Live cancellations need liveAcknowledged=true after the user confirmed that a cancelled stop-loss no longer protects the position.",
        inputSchema: z.object({ token: z.string().min(20), liveAcknowledged: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token, liveAcknowledged }) => {
        try {
          const data = await trading.executeCancel(token, { liveAcknowledged: !!liveAcknowledged });
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_prepare_basket",
      {
        title: "Prepare basket confirmation",
        description: "App-only validation of every basket leg and the policy. Creates one short-lived confirmation token; places nothing.",
        inputSchema: z.object({
          environment: environmentEnum,
          purpose: z.enum(["rebalance", "protective", "dca", "custom"]),
          title: z.string().min(1).max(80),
          drafts: z.array(orderDraftSchema).min(1).max(MAX_BASKET_LEGS),
          planId: z.string().optional(),
          notes: z.array(z.string().max(500)).max(20).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ environment, purpose, title, drafts, planId, notes }) => {
        try {
          const data = await trading.prepareBasket({
            environment, purpose, title,
            drafts: drafts as OrderDraft[],
            independentSells: purpose === "protective",
            ...(planId ? { planId } : {}),
            ...(notes ? { notes } : {}),
          });
          return result(data, "Basket validated. Explicit user confirmation is still required.");
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_execute_basket",
      {
        title: "Execute confirmed basket",
        description: "App-only destructive external write. Consumes a one-time basket token and sends the orders one by one. Never retry automatically.",
        inputSchema: z.object({ token: z.string().min(20), liveAcknowledged: z.boolean().optional().describe("Second confirmation that a Live write uses real money") }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token, liveAcknowledged }) => {
        try {
          const data = await trading.executeBasket(token, { liveAcknowledged: liveAcknowledged === true });
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_prepare_pie_change",
      {
        title: "Prepare pie change confirmation",
        description: "App-only validation of a pie change. Creates a short-lived one-time confirmation token; changes nothing.",
        inputSchema: pieDraftSchema.extend({ environment: environmentEnum }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async (draft) => {
        try {
          const data = await pies.preparePieChange(draft as PieChangeDraft);
          return result(data, "Pie change validated. Explicit user confirmation is still required.");
        } catch (error) {
          return toolError(error);
        }
      },
    );

    registerAppTool(
      server,
      "app_execute_pie_change",
      {
        title: "Execute confirmed pie change",
        description: "App-only external write. Consumes a one-time pie token. Never retry automatically.",
        inputSchema: z.object({ token: z.string().min(20), liveAcknowledged: z.boolean().optional().describe("Second confirmation that a Live pie will change") }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token, liveAcknowledged }) => {
        try {
          const data = await pies.executePieChange(token, { liveAcknowledged: liveAcknowledged === true });
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  return server;
}
