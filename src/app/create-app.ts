import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { RuntimeConfig } from "../core/config.js";
import { boundedMcpRequest, RequestTooLargeError } from "../core/http-request.js";
import { bearer, installOAuth, type OAuthVariables } from "../core/oauth.js";
import type { StateStore } from "../core/state-store.js";
import { TradingService, type InstrumentCache } from "../core/trading-service.js";
import { createMcpServer } from "../core/mcp.js";
import { APP_META } from "../shared/meta.js";

export interface AppDependencies { config: RuntimeConfig; store: StateStore; widgetHtml: () => Promise<string>; audit?: (event: string, details: Record<string, unknown>) => Promise<void>; fetcher?: typeof fetch; instrumentCache?: InstrumentCache }

export function createApp(deps: AppDependencies) {
  const app = new Hono<{ Variables: OAuthVariables }>();
  const trading = new TradingService(deps);
  app.use("*", secureHeaders({ referrerPolicy: "no-referrer", xFrameOptions: false }));
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version", "MCP-Session-Id", "Last-Event-ID"], exposeHeaders: ["MCP-Protocol-Version", "MCP-Session-Id", "WWW-Authenticate"] }));
  app.use("*", async (c, next) => { if (c.req.path !== "/health") c.header("Cache-Control", "no-store"); await next(); });
  installOAuth(app, deps.config, deps.store, deps.fetcher);
  app.get("/health", (c) => c.json({ ok: true, service: APP_META.name, version: APP_META.version, mcp: `${deps.config.publicBaseUrl}/mcp` }));
  app.use("/mcp", (c, next) => bearer(c, deps.config, next));
  app.all("/mcp", async (c) => {
    try {
      const request = await boundedMcpRequest(c.req.raw);
      const server = createMcpServer(trading, deps.config, deps.widgetHtml, c.get("oauthScopes"));
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      if (error instanceof RequestTooLargeError) return c.json({ error: "request_too_large" }, 413);
      console.error(JSON.stringify({ message: "MCP request failed", error: error instanceof Error ? error.message : String(error) }));
      return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }, 500);
    }
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
