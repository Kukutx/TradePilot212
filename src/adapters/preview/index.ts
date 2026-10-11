// Local browser preview: the full TradePilot UI on http://127.0.0.1:4212 without Cloudflare or a chat host.
// A small host page embeds the widget the way ChatGPT and Claude do (sandboxed iframe + MCP Apps bridge)
// and forwards its tool calls to an in-process MCP server.
//
//   pnpm preview          sample account, nothing leaves this machine
//   pnpm preview --demo   your Trading 212 Demo account from .env.local; Live keys are ignored
//
// Plans, alerts and targets live in memory and the scheduler does not run, so nothing happens unattended.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import dotenv from "dotenv";
import { build } from "esbuild";
import { createConfig, type RuntimeEnv } from "../../core/config.js";
import { createMcpServer } from "../../core/mcp.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { createServices } from "../../app/services.js";
import type { Position } from "../../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const args = process.argv.slice(2);
const demo = args.includes("--demo");
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7) ?? process.env.PREVIEW_PORT ?? 4212);
const host = "127.0.0.1";

function environment(): RuntimeEnv {
  if (!demo) return { TRADEPILOT_SAMPLE_DATA: "true" };
  dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  if (!process.env.T212_DEMO_API_KEY || !process.env.T212_DEMO_API_SECRET) {
    console.error("--demo needs T212_DEMO_API_KEY and T212_DEMO_API_SECRET in .env.local. Run plain `pnpm preview` for the sample account.");
    process.exit(1);
  }
  // The preview never sees Live keys, whatever .env.local holds.
  return {
    ...(process.env as RuntimeEnv),
    TRADEPILOT_SAMPLE_DATA: "false",
    DEFAULT_TRADING_ENV: "demo",
    T212_LIVE_API_KEY: "",
    T212_LIVE_API_SECRET: "",
    AUTOMATION_DEMO_ENABLED: "false",
    NOTIFY_WEBHOOK_URL: "",
  };
}

const config = createConfig(environment());
const services = createServices({ config, store: new MemoryStateStore(), audit: async () => {} });
const widgetPath = path.join(root, "dist", "widget", "index.html");
const widgetHtml = () => fs.readFile(widgetPath, "utf8");
const server = createMcpServer(services, config, widgetHtml, new Set(["trade:read", "trade:write"]));
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "tradepilot-preview", version: "1.0.0" });
await client.connect(clientSide);

interface Scenario {
  id: string;
  group: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: { en: string; zh: string };
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const value = (position: Position) => {
  const current = position.walletImpact?.currentValue;
  return typeof current === "number" ? current : position.quantity * position.currentPrice;
};

/** Views to switch between. Order and rebalance examples use the account's own holdings. */
async function scenarios(): Promise<Scenario[]> {
  const list: Scenario[] = [
    { id: "dashboard", group: "portfolio", tool: "get_portfolio_dashboard", args: {}, prompt: { en: "Show my portfolio dashboard.", zh: "看看我的投资组合。" } },
    { id: "allocation", group: "portfolio", tool: "analyze_portfolio_allocation", args: {}, prompt: { en: "Check my allocation for concentration risk.", zh: "检查一下我的持仓是否过于集中。" } },
    { id: "performance", group: "portfolio", tool: "get_portfolio_performance", args: {}, prompt: { en: "How has my portfolio performed this year?", zh: "我今年的收益怎么样？" } },
    { id: "income", group: "portfolio", tool: "get_income_summary", args: {}, prompt: { en: "What income did my portfolio pay?", zh: "我的组合派了多少股息和利息？" } },
    {
      id: "tradeplan", group: "orders", tool: "show_daily_trade_plan",
      args: { candidates: [
        { ticker: "AAPL", horizon: "medium", action: "buy", score: 78, risk: "medium", rationale: "Services growth and buybacks support the valuation.", suggestedQuantity: 2, thesis: "Steady compounding.", catalysts: ["Q4 earnings"], risks: ["China demand"], counterCase: "Valuation is already rich." },
        { ticker: "KO", horizon: "long", action: "sell", score: 55, risk: "low", rationale: "Trim a slow holding to fund growth." },
        { name: "Tesla", horizon: "short", action: "watch", score: 40, risk: "high", rationale: "Wait for delivery numbers." },
      ] },
      prompt: { en: "Give me today's trade ideas.", zh: "给我今天的交易思路。" },
    },
  ];

  const dashboard = await services.trading.getDashboard("demo");
  const holdings = [...dashboard.positions].filter((position) => (position.currentPrice ?? 0) > 0).sort((a, b) => value(b) - value(a));
  const [top, second] = holdings;
  if (top) {
    const name = top.instrument.name ?? top.instrument.ticker;
    const price = top.currentPrice!;
    list.push({
      id: "order", group: "orders", tool: "review_trading212_order_intent",
      args: { instrument: (second ?? top).instrument.ticker, side: "buy", type: "limit", limitPrice: round((second ?? top).currentPrice! * 0.98), sizing: { mode: "notional", amount: 200 } },
      prompt: { en: `Buy about 200 of ${(second ?? top).instrument.name ?? "it"} with a limit 2% below the price.`, zh: `用限价单买入约 200 的 ${(second ?? top).instrument.name ?? "这只股票"}，价格比现价低 2%。` },
    });
    list.push({
      id: "protective", group: "orders", tool: "review_protective_orders",
      args: { instrument: top.instrument.ticker, stopLossPrice: round(price * 0.9), takeProfitPrice: round(price * 1.15) },
      prompt: { en: `Set a stop-loss 10% below and a take-profit 15% above on ${name}.`, zh: `给 ${name} 设置低于现价 10% 的止损和高于 15% 的止盈。` },
    });
    const targets = holdings.slice(0, 4);
    list.push({
      id: "rebalance", group: "orders", tool: "plan_portfolio_rebalance",
      args: { targets: targets.map((position) => ({ ticker: position.instrument.ticker, weight: round(0.95 / targets.length, 4) })), cashWeight: 0.05, minTradeValue: 10 },
      prompt: { en: "Rebalance my largest holdings to equal weights and keep 5% cash.", zh: "把前几大持仓调成等权重，留 5% 现金。" },
    });
    const smallest = holdings.at(-1)!;
    list.push({
      id: "basket", group: "orders", tool: "review_order_basket",
      args: { title: "Rotate", orders: [
        { ticker: smallest.instrument.ticker, side: "sell", type: "market", quantity: round(Math.min(smallest.quantity, 1), 4) },
        { ticker: top.instrument.ticker, side: "buy", type: "limit", quantity: 1, limitPrice: round(price * 0.97), timeValidity: "DAY" },
      ] },
      prompt: { en: `Sell a little ${smallest.instrument.name ?? "of my smallest holding"} and buy one ${name} on a dip.`, zh: `卖一点 ${smallest.instrument.name ?? "最小的持仓"}，回调时买入一股 ${name}。` },
    });
  }

  const pending = dashboard.orders[0];
  if (pending?.id !== undefined) {
    const name = dashboard.positions.find((position) => position.instrument.ticker === pending.ticker)?.instrument.name ?? pending.ticker ?? "";
    list.push({ id: "cancel", group: "orders", tool: "review_order_cancel", args: { orderId: String(pending.id) }, prompt: { en: `Cancel my pending ${name} order.`, zh: `撤掉 ${name} 的挂单。` } });
  }

  const pies = await services.pies.listPies("demo").catch(() => null);
  list.push({ id: "pies", group: "pies", tool: "list_pies", args: {}, prompt: { en: "Show my pies.", zh: "看看我的 Pies。" } });
  const pie = pies?.pies[0];
  if (pie) {
    list.push({ id: "pie", group: "pies", tool: "get_pie", args: { pieId: pie.id }, prompt: { en: `Open my pie "${pie.name}".`, zh: `打开 Pie「${pie.name}」。` } });
    const tickers = pie.instruments?.map((slice) => slice.ticker) ?? Object.keys(pie.settings?.instrumentShares ?? {});
    if (tickers.length > 1) {
      list.push({
        id: "piechange", group: "pies", tool: "review_pie_change",
        args: { action: "update", pieId: pie.id, instrumentShares: Object.fromEntries(tickers.map((ticker) => [ticker, 1])) },
        prompt: { en: `Make every slice of "${pie.name}" equal.`, zh: `把「${pie.name}」的每个成分调成等权重。` },
      });
    }
  }
  list.push({ id: "automation", group: "automation", tool: "get_automation_overview", args: {}, prompt: { en: "What is on autopilot?", zh: "看看自动化设置。" } });
  return list;
}

/** Gives the automation page something to show on the sample account. */
async function seedSample(): Promise<void> {
  const calls: [string, Record<string, unknown>][] = [
    ["manage_investment_plans", { action: "create", label: "Monthly core", legs: [{ ticker: "VUSA", amount: 200 }, { ticker: "MSFT", amount: 100, orderType: "limit", limitOffsetPercent: 0.5 }], frequency: "monthly", dayOfMonth: 5 }],
    ["manage_investment_plans", { action: "create", label: "Weekly NVIDIA", legs: [{ ticker: "NVDA", amount: 50 }], frequency: "weekly", weekday: 1 }],
    // Saved targets, so the allocation view shows its drift panel and a plan can invest by them.
    ["manage_target_allocation", { action: "set", targets: ["VUSAl_EQ", "AAPL", "NVDA", "MSFT"].map((instrument) => ({ instrument, weight: 0.2375 })), cashWeight: 0.05 }],
    ["manage_investment_plans", { action: "create", label: "Monthly by targets", targetAmount: 500, frequency: "monthly", dayOfMonth: 20 }],
    ["manage_price_alerts", { action: "create", instrument: "AAPL", condition: "below", price: 210, note: "Add on a dip" }],
    ["manage_price_alerts", { action: "create", instrument: "NVDA", condition: "trailing_drop", percent: 8 }],
  ];
  for (const [name, input] of calls) {
    const outcome = await client.callTool({ name, arguments: input });
    if (outcome.isError) console.warn(`Could not seed ${name}:`, JSON.stringify(outcome.content).slice(0, 200));
  }
}

async function hostScript(): Promise<string> {
  const bundle = await build({ entryPoints: [path.join(here, "host.ts")], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, logLevel: "silent" });
  return bundle.outputFiles[0]!.text;
}

try {
  await fs.access(widgetPath);
} catch {
  console.error("The widget is not built. Run `pnpm build:widget` first, or start with `pnpm preview`, which builds it.");
  process.exit(1);
}
if (!demo) await seedSample();
const views = await scenarios();
const script = await hostScript();
const page = await fs.readFile(path.join(here, "page.html"), "utf8");
// Only this page may call tools: it carries a per-run token that other sites cannot read.
const token = crypto.randomBytes(16).toString("hex");
const origins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);

function send(response: http.ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

const httpServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      const boot = { token, mode: demo ? "demo" : "sample", scenarios: views };
      return send(response, 200, "text/html; charset=utf-8", page.replace("/*BOOT*/null", JSON.stringify(boot).replaceAll("<", "\\u003c")));
    }
    if (request.method === "GET" && url.pathname === "/host.js") return send(response, 200, "text/javascript; charset=utf-8", script);
    if (request.method === "GET" && url.pathname === "/widget.html") return send(response, 200, "text/html; charset=utf-8", await widgetHtml());
    if (request.method === "POST" && url.pathname === "/api/call") {
      if (!origins.has(request.headers.origin ?? "") || request.headers["x-preview-token"] !== token) return send(response, 403, "text/plain", "Forbidden");
      const { name, arguments: input } = await readJson(request) as { name?: unknown; arguments?: unknown };
      if (typeof name !== "string") return send(response, 400, "text/plain", "Missing tool name");
      const outcome = await client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
      return send(response, 200, "application/json", JSON.stringify(outcome));
    }
    send(response, 404, "text/plain", "Not found");
  } catch (error) {
    // The details go to the terminal, not to the page.
    console.error("Preview request failed:", error);
    send(response, 500, "text/plain", "The preview could not handle this request; see the terminal for details.");
  }
});

httpServer.listen(port, host, () => {
  console.log(`TradePilot preview (${demo ? "your Demo account" : "sample account"}): http://${host}:${port}`);
  console.log("Press Ctrl+C to stop.");
});
