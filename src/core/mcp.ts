import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { TradingService } from "./trading-service.js";
import type { OrderDraft, OrderIntent, TradeCandidate } from "../shared/contracts.js";
import { APP_META } from "../shared/meta.js";

const WIDGET_URI = "ui://tradepilot212/trading-dashboard.html";

function result(data: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { kind: "error", message },
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

export function createMcpServer(
  trading: TradingService,
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
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: "Interactive Trading 212 Demo/Live dashboard with explicit human order confirmation.",
    },
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
      inputSchema: { environment: environmentWithDefault },
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
      inputSchema: {
        environment: environmentWithDefault,
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
      },
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

  registerAppTool(
    server,
    "show_daily_trade_plan",
    {
      title: "Trading 212 Daily Trade Plan",
      description:
        "Render stock candidates already researched by ChatGPT as actionable short (<=1 week), medium (<=1 month), and long (>=1 year) cards. This tool never places orders. Include a current referencePrice for actionable Market-order candidates whenever possible, especially when the app-level notional cap is enabled.",
      inputSchema: {
        environment: environmentWithDefault,
        candidates: z.array(candidateSchema).min(1).max(30),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ environment, candidates }) => {
      try {
        const data = { ...(await trading.getTradePlan(environment, candidates as TradeCandidate[])), writeEnabled: canWrite };
        return result(
          data,
          `Rendered ${candidates.length} researched candidates. No trade has been placed; execution is only available after explicit user confirmation in the widget.`,
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
          "Preferred order-entry tool for natural-language requests. Accept a stock ticker, symbol, or company name and resolve it to Trading 212. Supports exact quantity, a target monetary amount, buying with a percentage of available cash, selling a percentage of the current tradable position, or selling all available shares. This tool is review-only: it reads current account/position data, computes an editable standard quantity order, and opens the confirmation UI; it never submits an order. For notional sizing, provide a current referencePrice. If the requested amount currency differs from the instrument quote currency, also provide fxRateToInstrumentCurrency (instrument-currency units per 1 requested-currency unit). Examples: 'buy about €100 of NVDA' => notional sizing; 'use 20% of my available cash to buy Apple' => cash_percent 20; 'sell half my Apple' => position_percent 50; 'sell all NVDA' => all_available.",
        inputSchema: {
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
        },
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
        inputSchema: orderDraftSchema.shape,
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
      inputSchema: { environment: environmentEnum },
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
      inputSchema: { environment: environmentEnum, candidates: z.array(candidateSchema).min(1).max(30) },
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
        inputSchema: orderDraftSchema.shape,
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
        inputSchema: { token: z.string().min(20) },
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
      "app_prepare_cancel",
      {
        title: "Prepare order cancellation",
        description: "App-only cancellation validation; does not cancel yet.",
        inputSchema: { environment: environmentEnum, orderId: z.string().min(1) },
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
        inputSchema: { token: z.string().min(20) },
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
