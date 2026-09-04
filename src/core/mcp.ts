import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { TradingService } from "./trading-service.js";
import type { OrderDraft, TradeCandidate } from "../shared/contracts.js";
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

const environmentSchema = z.enum(["demo", "live"]);
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
  environment: environmentSchema,
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

export function createMcpServer(
  trading: TradingService,
  config: RuntimeConfig,
  widgetHtml: () => Promise<string>,
  scopes: ReadonlySet<string> = new Set(["trade:read", "trade:write"]),
): McpServer {
  const canWrite = scopes.has("trade:write");
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
        "Read the user's Trading 212 Invest account summary, positions and pending orders and render the interactive dashboard. Use Demo unless the user explicitly asks for Live.",
      inputSchema: { environment: environmentSchema.default("demo") },
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
        "Resolve a stock symbol/name to Trading 212's exact ticker. Read-only. Use this before constructing an order when the exact ticker is unclear.",
      inputSchema: {
        environment: environmentSchema.default("demo"),
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
        "Render stock candidates already researched by ChatGPT as actionable short (<=1 week), medium (<=1 month), and long (>=1 year) cards. This tool does not place orders. Include a current referencePrice for actionable Market-order candidates so the app can enforce its hard notional cap. Use Demo unless the user explicitly selected Live.",
      inputSchema: {
        environment: environmentSchema.default("demo"),
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
          `Rendered ${candidates.length} researched candidates. No trade has been placed; execution is only available after the user clicks the widget confirmation button.`,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (canWrite) {
    registerAppTool(
      server,
      "review_trading212_order",
      {
        title: "Review Trading 212 Order",
        description:
          "Open an editable order draft in the Trading 212 widget. This is review-only and never places an order. The user must click Review order and then a separate Confirm button inside the widget.",
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

  // App-only tools: hidden from the model. The widget invokes them from explicit user actions.
  registerAppTool(
    server,
    "app_get_dashboard",
    {
      title: "Refresh dashboard",
      description: "App-only dashboard refresh.",
      inputSchema: { environment: environmentSchema },
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
      inputSchema: { environment: environmentSchema, candidates: z.array(candidateSchema).min(1).max(30) },
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
        inputSchema: { environment: environmentSchema, orderId: z.string().min(1) },
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
