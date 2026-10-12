// Start the bundled stdio server from an empty directory (no node_modules) and check the tool list.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const bundle = path.resolve("plugin/server.mjs");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "tradepilot-stdio-"));
const env = { PATH: process.env.PATH ?? "", TRADEPILOT_DATA_DIR: path.join(work, "data"), TRADEPILOT_ROOT: work };

async function session(extraEnv, calls = []) {
  const child = spawn(process.execPath, [bundle], { cwd: work, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const responses = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) { const message = JSON.parse(line); if (message.id !== undefined) responses.set(message.id, message); }
    }
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const wait = async (id) => {
    for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!responses.has(id)) throw new Error(`No response ${id}. stderr: ${stderr}`);
    return responses.get(id);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (await wait(2)).result.tools.map((tool) => tool.name);
  const results = [];
  for (const [index, [name, args]] of calls.entries()) {
    // Arguments can be worked out from the earlier results, such as an id a previous call returned.
    send({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: { name, arguments: typeof args === "function" ? args(results) : args } });
    results.push((await wait(10 + index)).result);
  }
  child.kill();
  return { tools, results };
}
const listTools = async (extraEnv) => (await session(extraEnv)).tools;

const readOnly = await listTools({});
for (const name of ["get_portfolio_dashboard", "get_holding_detail", "get_portfolio_performance", "analyze_portfolio_allocation", "get_market_hours", "plan_portfolio_rebalance", "get_trading_policy", "list_investment_plans", "list_pies", "get_pie", "list_price_alerts", "manage_price_alerts", "manage_trade_journal", "get_journal_review", "manage_target_allocation", "get_tax_year_summary", "get_quote", "get_automation_overview", "get_watchlist", "manage_watchlist", "get_portfolio_today"])
  if (!readOnly.includes(name)) throw new Error(`Missing read tool ${name}`);
if (readOnly.some((name) => name.startsWith("app_execute") || name.startsWith("app_prepare") || name.startsWith("review_") || name === "manage_investment_plans"))
  throw new Error("Write tools must be absent unless TRADEPILOT_ALLOW_WRITES=true");
const writable = await listTools({ TRADEPILOT_ALLOW_WRITES: "true" });
if (!["app_execute_order", "app_execute_basket", "app_execute_pie_change", "manage_investment_plans", "manage_price_alerts", "review_protective_orders", "review_portfolio_stops", "review_pie_change"].every((name) => writable.includes(name))) throw new Error("Write tools missing with TRADEPILOT_ALLOW_WRITES=true");
// Sample data: the bundle serves a simulated account with no Trading 212 keys and no network.
const sample = await session({ TRADEPILOT_SAMPLE_DATA: "true", T212_LIVE_API_KEY: "x", T212_LIVE_API_SECRET: "x" }, [["get_portfolio_dashboard", {}], ["get_portfolio_dashboard", { environment: "live" }], ["get_holding_detail", { instrument: "NVDA" }], ["get_journal_review", {}], ["get_portfolio_performance", { period: "all", benchmark: "EUNL" }], ["get_portfolio_today", {}]]);
const [dashboard, live, holding, review, performance, today] = sample.results;
// The day's moves: every sample holding against its simulated previous close, added up in the account currency.
const day = today.structuredContent?.today;
if (today.isError || today.structuredContent?.kind !== "portfolio" || day?.kind !== "portfolio_today" || day.moves.length !== today.structuredContent.positions.length
  || !day.moves.every((move) => move.previousClose && move.change !== undefined && move.profitLoss !== undefined) || day.total?.counted !== day.moves.length)
  throw new Error(`Portfolio today failed: ${JSON.stringify(today).slice(0, 400)}`);
// A fresh store has no recorded values, so no time-weighted return and nothing to compare; the benchmark choice is accepted.
if (performance.isError || performance.structuredContent?.kind !== "performance" || performance.structuredContent.benchmark) throw new Error(`Performance with a benchmark failed: ${JSON.stringify(performance).slice(0, 300)}`);
// The journal review reads the sample fills; a fresh store has no notes on them.
if (review.isError || review.structuredContent?.kind !== "journal_review" || !(review.structuredContent.fills > 0) || review.structuredContent.withNote !== 0) throw new Error(`Journal review failed: ${JSON.stringify(review).slice(0, 300)}`);
// One holding: its position, the sample stop-loss, a year of fills and the simulated daily closes ending at the last price.
const detail = holding.structuredContent;
if (holding.isError || detail?.kind !== "holding" || detail.ticker !== "NVDA_US_EQ" || !detail.position || detail.orders?.length !== 1 || !detail.history?.fills?.length) throw new Error(`Holding detail failed: ${JSON.stringify(holding).slice(0, 300)}`);
if (!(detail.prices?.points?.length > 200) || detail.prices.points.at(-1).close !== detail.position.currentPrice) throw new Error(`Holding detail lacks the daily closes: ${JSON.stringify(detail.prices ?? detail.pricesProblem).slice(0, 300)}`);
if (dashboard.isError || !dashboard.structuredContent?.credentials?.sample || !(dashboard.structuredContent.positions?.length > 0)) throw new Error(`Sample dashboard failed: ${JSON.stringify(dashboard).slice(0, 300)}`);
if (!live.isError && live.structuredContent?.credentials?.live) throw new Error("Live must stay off in sample mode");
// Hosts that show only text get the holdings in the tool text too.
const text = dashboard.content?.map((item) => item.text ?? "").join("\n") ?? "";
if (!dashboard.structuredContent.positions.every((position) => text.includes(position.instrument.ticker))) throw new Error(`Dashboard text lacks the holdings: ${text.slice(0, 300)}`);
// The watchlist: an instrument not held gets its simulated price, range and the alert armed on it; the holding page says it is watched.
const watch = await session({ TRADEPILOT_SAMPLE_DATA: "true" }, [
  ["manage_watchlist", { action: "add", instrument: "TSLA", note: "Wait for delivery numbers" }],
  ["manage_price_alerts", { action: "create", instrument: "TSLA_US_EQ", condition: "above", price: 260 }],
  ["get_watchlist", {}],
  ["get_holding_detail", { instrument: "TSLA" }],
  ["manage_watchlist", { action: "note", instrument: "TSLA", note: "After the call" }],
  ["manage_watchlist", { action: "remove", instrument: "TSLA_US_EQ" }],
  ["get_watchlist", {}],
]);
const [watchAdded, , watchlist, watched, noted, watchRemoved, emptied] = watch.results;
const watchRow = watchlist.structuredContent?.items?.[0];
if (watchAdded.isError || watchAdded.structuredContent?.item?.ticker !== "TSLA_US_EQ") throw new Error(`Adding to the watchlist failed: ${JSON.stringify(watchAdded).slice(0, 300)}`);
if (watchlist.isError || watchRow?.ticker !== "TSLA_US_EQ" || !(watchRow.price > 0) || watchRow.priceSource !== "sample" || !(watchRow.spark?.closes?.length > 30) || watchRow.levels?.[0]?.kind !== "alert" || watchRow.note !== "Wait for delivery numbers")
  throw new Error(`Watchlist failed: ${JSON.stringify(watchlist).slice(0, 300)}`);
if (watched.isError || watched.structuredContent?.position || watched.structuredContent?.quote?.price !== watchRow.price || !watched.structuredContent?.watching) throw new Error(`Watched holding page failed: ${JSON.stringify(watched).slice(0, 300)}`);
if (noted.isError || noted.structuredContent?.item?.note !== "After the call") throw new Error(`Changing a watchlist note failed: ${JSON.stringify(noted).slice(0, 300)}`);
if (watchRemoved.isError || emptied.structuredContent?.items?.length !== 0) throw new Error(`Removing from the watchlist failed: ${JSON.stringify(emptied).slice(0, 300)}`);
// Saved targets: the allocation shows their drift and a rebalance without targets uses them.
const targets = await session({ TRADEPILOT_SAMPLE_DATA: "true" }, [
  ["manage_target_allocation", { action: "set", targets: [{ instrument: "AAPL_US_EQ", weight: 0.5 }, { instrument: "KO_US_EQ", weight: 0.4 }] }],
  ["analyze_portfolio_allocation", {}],
  ["plan_portfolio_rebalance", {}],
  ["plan_portfolio_rebalance", { buyOnly: true }],
]);
const [saved, allocation, rebalance, buyOnly] = targets.results;
if (saved.isError || saved.structuredContent?.targets?.cashWeight !== 0.1) throw new Error(`Saving targets failed: ${JSON.stringify(saved).slice(0, 300)}`);
if (!allocation.structuredContent?.drift?.rows?.length) throw new Error(`Allocation lacks the drift: ${JSON.stringify(allocation).slice(0, 300)}`);
if (rebalance.isError || !rebalance.structuredContent?.rebalance?.trades?.length) throw new Error(`Rebalance from saved targets failed: ${JSON.stringify(rebalance).slice(0, 300)}`);
const buyOnlyPlan = buyOnly.structuredContent?.rebalance;
if (buyOnly.isError || !buyOnlyPlan?.buyOnly || buyOnlyPlan.trades.some((trade) => trade.side !== "buy")) throw new Error(`Buy-only rebalance failed: ${JSON.stringify(buyOnly).slice(0, 300)}`);
// A plan by targets opens a basket of buys split across the saved targets, without placing anything.
const byTargets = await session({ TRADEPILOT_SAMPLE_DATA: "true", TRADEPILOT_ALLOW_WRITES: "true" }, [
  ["manage_investment_plans", { action: "create", targetAmount: 500, frequency: "monthly", dayOfMonth: 20 }],
  ["review_investment_plan", (previous) => ({ planId: previous[0].structuredContent?.plan?.id ?? "missing" })],
]);
const [planSaved, planBasket] = byTargets.results;
if (planSaved.isError || planSaved.structuredContent?.plan?.targetAmount !== 500) throw new Error(`Saving a plan by targets failed: ${JSON.stringify(planSaved).slice(0, 300)}`);
const legTickers = planBasket.structuredContent?.legs?.map((leg) => leg.draft?.ticker) ?? [];
if (planBasket.isError || !legTickers.length || !legTickers.every((ticker) => ["AAPL_US_EQ", "KO_US_EQ"].includes(ticker))) throw new Error(`Plan by targets basket failed: ${JSON.stringify(planBasket).slice(0, 300)}`);
await fs.rm(work, { recursive: true, force: true });
console.log(`STDIO_SMOKE_OK ${readOnly.length} read-only tools, ${writable.length} with writes enabled, sample data serves ${dashboard.structuredContent.positions.length} holdings`);
