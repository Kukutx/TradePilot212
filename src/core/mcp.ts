import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { TradingService } from "./trading-service.js";
import { DEFAULT_HISTORY_PAGES, MAX_HISTORY_PAGES, parseWindow, type InsightsService } from "./insights-service.js";
import type { OrderDraft, OrderIntent, TradeCandidate } from "../shared/contracts.js";
import { APP_META } from "../shared/meta.js";
import { asStructuredError } from "./errors.js";

const WIDGET_URI = "ui://tradepilot212/trading-dashboard.html";

function result(data: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text }],
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

const windowSchema = {
  period: z.enum(["1m", "3m", "ytd", "1y", "all"]).default("all").describe("Shortcut window ending now. Ignored when from is given."),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  maxPages: z.number().int().min(1).max(MAX_HISTORY_PAGES).default(DEFAULT_HISTORY_PAGES)
    .describe("History pages of 50 records to read per data set. Trading 212 allows about 20 history requests per minute."),
};

export function createMcpServer(
  trading: TradingService,
  insights: InsightsService,
  config: RuntimeConfig,
  widgetHtml: () => Promise<string>,
  scopes: ReadonlySet<string> = new Set(["trade:read", "trade:write"]),
): McpServer {
  const canWrite = scopes.has("trade:write");
  const environmentWithDefault = environmentEnum.default(config.defaultTradingEnvironment);
  const server = new McpServer({ name: "tradepilot212", version: APP_META.version });

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
        return result(
          { environment, query, credentials: credentialStatus(config), instruments },
          instruments.length
            ? `Found ${instruments.length} Trading 212 instrument matches.`
            : `No matches or ${environment.toUpperCase()} credentials are not configured.`,
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
      _meta: {},
    },
    async ({ environment, ...limits }) => {
      try {
        const data = await insights.allocation(environment, limits);
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
      _meta: {},
    },
    async ({ environment, period, from, to, maxPages }) => {
      try {
        const data = await insights.performance(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), maxPages);
        return result(data, `Realized P/L ${data.realizedProfitLoss} ${data.accountCurrency}, income ${data.income.dividends + data.income.interest}, costs ${data.costs.total}${data.coverage.truncated ? " (history truncated)" : ""}.`);
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
      _meta: {},
    },
    async ({ environment, period, from, to, maxPages }) => {
      try {
        const data = await insights.income(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), maxPages);
        return result(data, `Income ${data.total} ${data.accountCurrency} in the selected period; trailing 12 months ${data.trailing12Months}.`);
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
      description: "List executed fills with price, quantity, net value, realized P/L, FX rate and costs, newest first. Optionally filter by ticker or symbol. Read-only.",
      inputSchema: z.object({
        environment: environmentWithDefault,
        ticker: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        ...windowSchema,
      }),
      annotations: readOnly,
      _meta: {},
    },
    async ({ environment, ticker, limit, period, from, to }) => {
      try {
        const data = await insights.tradeHistory(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }), ticker, limit);
        return result(data, `Returned ${data.fills.length} fills${data.truncated ? " (history truncated)" : ""}.`);
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
        return result({ kind: "market_status", environment, ...data }, `${data.ticker}: ${data.session}${data.nextOpen ? `, next open ${data.nextOpen}` : ""}.`);
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
          const created = await insights.requestExport(environment, parseWindow({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }));
          return result({ kind: "history_export", environment, requested: created }, `Requested report ${created.reportId}. List exports again in a minute for the download link.`);
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
        return result({ environment, activity }, `Returned ${activity.length} recent TradePilot activity events.`);
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
          "Preferred order-entry tool for natural-language requests. Accept a stock ticker, symbol, or company name and resolve it to Trading 212. Supports exact quantity, a target monetary amount, buying with a percentage of available cash, selling a percentage of the total held position (when that quantity is tradable), or selling all currently available shares. This tool is review-only: it reads current account/position data, computes an editable standard quantity order, and opens the confirmation UI; it never submits an order. For notional sizing, provide a current referencePrice. If the requested amount currency differs from the instrument quote currency, also provide fxRateToInstrumentCurrency (instrument-currency units per 1 requested-currency unit). Examples: 'buy about €100 of NVDA' => notional sizing; 'use 20% of my available cash to buy Apple' => cash_percent 20; 'sell half my Apple' => position_percent 50 of the held position; 'sell all NVDA' => all_available.",
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
        inputSchema: orderDraftSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      },
      async (draft) =>
        result(
          { kind: "order_draft", draft: draft as OrderDraft, credentials: credentialStatus(config), writeEnabled: true },
          "Order draft opened for human review. No order has been submitted.",
        ),
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
        inputSchema: z.object({ token: z.string().min(20) }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token }) => {
        try {
          const data = await trading.executeOrder(token);
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
        description: "App-only destructive write. Consumes a one-time cancellation token.",
        inputSchema: z.object({ token: z.string().min(20) }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ token }) => {
        try {
          const data = await trading.executeCancel(token);
          return result(data, data.message);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  return server;
}
