import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { TOOL_OUTPUT } from "./tool-output.js";

const leg = { ticker: "AAPL_US_EQ", side: "buy", type: "limit", quantity: 1, limitPrice: 100 };
const candidate = { ticker: "AAPL_US_EQ", horizon: "short", action: "buy", score: 50, rationale: "Steady", risk: "low" };
/** Arguments that make each tool succeed on the sample account; tools left out take only `environment`. */
const ARGS: Record<string, Record<string, unknown>> = {
  search_trading212_instruments: { query: "apple" },
  list_new_instruments: { days: 30 },
  get_market_hours: { instrument: "AAPL" },
  get_holding_detail: { instrument: "AAPL" },
  app_get_holding: { instrument: "AAPL" },
  app_get_holding_covariance: { ticker: "AAPL_US_EQ" },
  get_order_status: { orderId: "81234" },
  get_quote: { instrument: "AAPL" },
  get_pie: { pieId: 4101 },
  show_daily_trade_plan: { candidates: [candidate] },
  app_get_trade_plan: { candidates: [candidate] },
  review_trading212_order: leg,
  review_trading212_order_intent: { instrument: "AAPL", side: "buy", orderType: "limit", sizing: { mode: "quantity", quantity: 1 }, limitPrice: 100 },
  review_pie_change: { action: "update", pieId: 4101, name: "Renamed" },
  review_protective_orders: { instrument: "AAPL", stopLossPrice: 100 },
  review_order_basket: { orders: [leg] },
  review_order_cancel: { orderId: "81234" },
  plan_portfolio_rebalance: { targets: [{ ticker: "AAPL_US_EQ", weight: 0.5 }] },
  manage_target_allocation: { action: "set", targets: [{ instrument: "AAPL", weight: 0.5 }] },
  manage_watchlist: { action: "add", instrument: "MSFT" },
  manage_price_alerts: { action: "create", instrument: "AAPL", condition: "above", price: 999 },
  manage_account_alerts: { action: "create", condition: "value_above", amount: 1e9 },
  manage_trade_journal: { action: "add", instrument: "AAPL", thesis: "Steady" },
  manage_investment_plans: { action: "create", legs: [{ ticker: "AAPL_US_EQ", amount: 10 }], frequency: "monthly", dayOfMonth: 3 },
  manage_history_export: { action: "read", rows: 3 },
  app_prepare_order: { ...leg, environment: "demo" },
  app_prepare_cancel: { orderId: "81234" },
  app_prepare_basket: { purpose: "custom", title: "Basket", drafts: [{ ...leg, environment: "demo" }] },
  app_prepare_pie_change: { action: "update", pieId: 4101, name: "Renamed" },
};
/**
 * Run after the others: a plan to review and tokens to execute. An unknown execution to verify cannot be made on the
 * sample account, so that tool is checked by its schema alone.
 */
const LATER = ["review_investment_plan", "app_execute_order", "app_execute_cancel", "app_execute_basket", "app_execute_pie_change", "app_verify_unknown_execution"];

describe("tool output schemas", () => {
  it("declares what every tool returns, and every tool's result on the sample account matches it", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", TRADEPILOT_ALLOW_WRITES: "true" } as RuntimeEnv);
    const services = createServices({ config, store: new MemoryStateStore() });
    const server = createMcpServer(services, config, async () => "<html></html>");
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBe(57);
    for (const tool of tools) {
      expect(TOOL_OUTPUT[tool.name], tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object", required: ["kind"] });
      // Not read-only: says whether calling it again with the same arguments changes anything more.
      if (!tool.annotations?.readOnlyHint) expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
    }
    expect(tools.find((tool) => tool.name === "app_execute_order")!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });

    const kept: Record<string, Record<string, unknown>> = {};
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: { environment: "demo", ...args } });
      const text = (reply.content as Array<{ text?: string }>).map((item) => item.text).join("\n");
      // A result that did not match its schema comes back as an error naming it.
      expect(text, name).not.toMatch(/Output validation error/);
      expect(reply.isError, `${name}: ${text}`).toBeFalsy();
      kept[name] = reply.structuredContent as Record<string, unknown>;
    };
    for (const tool of tools.filter((item) => !LATER.includes(item.name))) await call(tool.name, ARGS[tool.name] ?? {});
    const planId = String((kept.manage_investment_plans!.plan as { id: string }).id);
    await call("review_investment_plan", { planId });
    for (const name of ["order", "cancel", "basket", "pie_change"]) await call(`app_execute_${name}`, { token: kept[`app_prepare_${name}`]!.token });
    expect(kept.app_execute_order!.kind).toBe("order_execution");
  }, 60_000);
});

describe("tool output fields", () => {
  it("takes a figure that could not be computed, and lists numbers as numbers", () => {
    const schema = TOOL_OUTPUT.analyze_portfolio_allocation!;
    expect(schema.safeParse({ kind: "allocation", cashWeight: Number.NaN, totalValue: Number.POSITIVE_INFINITY }).success).toBe(true);
    expect(schema.safeParse({ kind: "allocation", cashWeight: "0.1" }).success).toBe(false);
    expect(z.toJSONSchema(schema, { io: "output" }).properties!.cashWeight).toMatchObject({ type: ["number", "null"] });
  });
});

describe("the server's settings in tool results", () => {
  it("counts the tax year from TAX_YEAR_START in TIMEZONE, and tells the widget both", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", TAX_YEAR_START: "04-06", TIMEZONE: "Europe/London" } as RuntimeEnv);
    const server = createMcpServer(createServices({ config, store: new MemoryStateStore() }), config, async () => "<html></html>");
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const tax = (await client.callTool({ name: "get_tax_year_summary", arguments: {} })).structuredContent as { yearStart: string; timeZone: string };
    expect(tax).toMatchObject({ yearStart: "04-06", timeZone: "Europe/London" });
    const dashboard = (await client.callTool({ name: "get_portfolio_dashboard", arguments: {} })).structuredContent as { preferences: unknown };
    expect(dashboard.preferences).toEqual({ timeZone: "Europe/London", taxYearStart: "04-06" });
    expect((await client.callTool({ name: "get_tax_year_summary", arguments: {} })).structuredContent).toMatchObject({ preferences: { timeZone: "Europe/London", taxYearStart: "04-06" } });
    // Without TIMEZONE, a year from 6 April is counted in London and any other in UTC.
    const plain = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", TAX_YEAR_START: "04-06" } as RuntimeEnv);
    const other = createMcpServer(createServices({ config: plain, store: new MemoryStateStore() }), plain, async () => "<html></html>");
    const [otherServer, otherClient] = InMemoryTransport.createLinkedPair();
    await other.connect(otherServer);
    const second = new Client({ name: "test", version: "0" });
    await second.connect(otherClient);
    expect((await second.callTool({ name: "get_tax_year_summary", arguments: {} })).structuredContent).toMatchObject({ yearStart: "04-06", timeZone: "Europe/London" });
    expect((await second.callTool({ name: "get_tax_year_summary", arguments: { yearStart: "01-01" } })).structuredContent).toMatchObject({ yearStart: "01-01", timeZone: "UTC" });
    // A year asked for another way still counts that way.
    expect((await client.callTool({ name: "get_tax_year_summary", arguments: { yearStart: "01-01", timeZone: "UTC" } })).structuredContent).toMatchObject({ yearStart: "01-01", timeZone: "UTC" });
  }, 30_000);
});
