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
import { watchKey } from "../../core/watchlist.js";
import { createServices } from "../../app/services.js";
import type { Position } from "../../shared/contracts.js";
import type { PlanRun } from "../../shared/automation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const args = process.argv.slice(2);
const demo = args.includes("--demo");
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7) ?? process.env.PREVIEW_PORT ?? 4212);
const host = "127.0.0.1";

/** Notifications go to the preview itself, which prints them: the automation page shows them set, and its test works. */
const NOTIFY_HERE = { NOTIFY_WEBHOOK_URL: `http://${host}:${port}/__notify`, NOTIFY_QUIET_HOURS: "22-07" };

function environment(): RuntimeEnv {
  if (!demo) return { TRADEPILOT_SAMPLE_DATA: "true", ...NOTIFY_HERE };
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
    // Yours are never sent to: notifications go to the preview.
    ...NOTIFY_HERE,
  };
}

const config = createConfig(environment());
const store = new MemoryStateStore();
const services = createServices({ config, store, audit: async () => {} });
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
    { id: "today", group: "portfolio", tool: "get_portfolio_today", args: {}, prompt: { en: "How are my holdings doing today?", zh: "我的持仓今天表现怎么样？" } },
    { id: "allocation", group: "portfolio", tool: "analyze_portfolio_allocation", args: {}, prompt: { en: "Check my allocation for concentration risk.", zh: "检查一下我的持仓是否过于集中。" } },
    { id: "performance", group: "portfolio", tool: "get_portfolio_performance", args: {}, prompt: { en: "How has my portfolio performed this year?", zh: "我今年的收益怎么样？" } },
    { id: "income", group: "portfolio", tool: "get_income_summary", args: {}, prompt: { en: "What income did my portfolio pay?", zh: "我的组合派了多少股息和利息？" } },
    { id: "holding", group: "portfolio", tool: "get_holding_detail", args: { instrument: "NVDA" }, prompt: { en: "Show me everything about my NVIDIA position.", zh: "看看我的英伟达持仓详情。" } },
    { id: "journal", group: "portfolio", tool: "get_holding_detail", args: { instrument: "AAPL" }, prompt: { en: "Why did I buy Apple, and how did it go?", zh: "我当初为什么买苹果？后来怎么样了？" } },
    { id: "review", group: "portfolio", tool: "get_journal_review", args: { period: "all" }, prompt: { en: "Look back over my trade journal: which reasons worked?", zh: "复盘一下我的交易日志：哪些理由靠谱？" } },
    { id: "watchlist", group: "portfolio", tool: "get_watchlist", args: {}, prompt: { en: "Show my watchlist.", zh: "看看我的自选。" } },
    { id: "listings", group: "portfolio", tool: "list_new_instruments", args: { days: 30 }, prompt: { en: "What did Trading 212 list lately?", zh: "Trading 212 最近上架了什么？" } },
    { id: "trades", group: "portfolio", tool: "get_trade_history", args: { period: "all", limit: 200, includeUnfilled: true }, prompt: { en: "Show my trades.", zh: "看看我的成交记录。" } },
    { id: "tradesnvda", group: "portfolio", tool: "get_trade_history", args: { ticker: "NVDA", from: "2026-01-01", to: "2026-06-30", limit: 50 }, prompt: { en: "How did my NVIDIA trades go in the first half of the year?", zh: "上半年我的英伟达交易做得怎么样？" } },
    { id: "cash", group: "portfolio", tool: "get_cash_history", args: { period: "all", limit: 500 }, prompt: { en: "Show my deposits, withdrawals and dividends.", zh: "看看我的入金、出金和分红。" } },
    { id: "orderstatus", group: "portfolio", tool: "get_order_status", args: { orderId: "81234" }, prompt: { en: "Did my Apple limit order fill yet?", zh: "我的苹果限价单成交了吗？" } },
    { id: "exports", group: "portfolio", tool: "manage_history_export", args: { action: "list" }, prompt: { en: "Which Trading 212 reports do I have?", zh: "我有哪些 Trading 212 报表？" } },
    { id: "rules", group: "portfolio", tool: "get_trading_policy", args: {}, prompt: { en: "What limits does TradePilot put on my orders?", zh: "TradePilot 对我的下单有哪些限制？" } },
    { id: "taxyear", group: "portfolio", tool: "get_tax_year_summary", args: { yearStart: "04-06", timeZone: "Europe/London" }, prompt: { en: "What were my gains in the UK tax year?", zh: "我这个英国税年的收益是多少？" } },
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
    const risky = second ?? top;
    list.push({
      id: "risk", group: "orders", tool: "review_trading212_order_intent",
      args: { instrument: risky.instrument.ticker, side: "buy", type: "market", sizing: { mode: "risk", percent: 1, stopLossPrice: round(risky.currentPrice! * 0.92) } },
      prompt: { en: `Buy ${risky.instrument.name ?? "it"}, risking 1% of my account with a stop 8% below.`, zh: `买入 ${risky.instrument.name ?? "这只股票"}，止损设在现价下 8%，最多亏账户的 1%。` },
    });
    list.push({
      id: "protective", group: "orders", tool: "review_protective_orders",
      args: { instrument: top.instrument.ticker, stopLossPrice: round(price * 0.9), takeProfitPrice: round(price * 1.15) },
      prompt: { en: `Set a stop-loss 10% below and a take-profit 15% above on ${name}.`, zh: `给 ${name} 设置低于现价 10% 的止损和高于 15% 的止盈。` },
    });
    list.push({
      id: "stops", group: "orders", tool: "review_portfolio_stops", args: {},
      prompt: { en: "Put a stop-loss on every holding that doesn't have one.", zh: "给所有还没有止损的持仓挂上止损。" },
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
    // A watchlist of instruments held and not, with an alert and the pending Tesla limit buy around them.
    ["manage_watchlist", { action: "add", instrument: "TSLA", note: "Wait for delivery numbers" }],
    ["manage_watchlist", { action: "add", instrument: "ASML", note: "Buy below 600 if chip orders hold up" }],
    ["manage_watchlist", { action: "add", instrument: "AMZN" }],
    ["manage_watchlist", { action: "add", instrument: "NVDA" }],
    ["manage_watchlist", { action: "add", instrument: "EUNL" }],
    // A listing alert on stocks, so the new-listings panel shows one on.
    ["manage_listing_alert", { action: "set", types: ["STOCK"] }],
    // A goal fifteen years out, so the performance tab shows its progress and range.
    ["manage_goal", { action: "set", name: "Retirement pot", target: 150_000, by: `${new Date().getUTCFullYear() + 15}-12-31`, monthly: 500 }],
    ["manage_price_alerts", { action: "create", instrument: "TSLA", condition: "above", price: 260, note: "Breakout" }],
    ["manage_price_alerts", { action: "create", instrument: "ASML", condition: "below", price: 600 }],
  ];
  for (const [name, input] of calls) {
    const outcome = await client.callTool({ name, arguments: input });
    if (outcome.isError) console.warn(`Could not seed ${name}:`, JSON.stringify(outcome.content).slice(0, 200));
  }
  // Day's-move alerts set last week, and one alert check, so the alerts show their last prices and the day's move.
  const lastWeek = new Date(Date.now() - 7 * 86_400_000);
  // The weekly plan's last runs, written onto the saved plan: two confirmed and sent, then one skipped. Nothing is sent.
  const weekly = (await services.automation.listPlans("demo")).find((plan) => plan.label === "Weekly NVIDIA");
  if (weekly) {
    const due = (weeks: number) => new Date(Date.parse(weekly.nextRunAt) - weeks * 7 * 86_400_000);
    const sent = (weeks: number): PlanRun => ({ dueAt: due(weeks).toISOString(), at: new Date(due(weeks).getTime() + 4 * 60_000).toISOString(), outcome: "submitted", by: "you", submitted: 1, legs: 1, message: "1 of 1 order(s) submitted to Trading 212 DEMO." });
    const skipped: PlanRun = { dueAt: due(1).toISOString(), at: new Date(due(1).getTime() - 86_400_000).toISOString(), outcome: "left_out", by: "you", message: `Skipped the run due ${due(1).toISOString()}.` };
    await store.put(`plan:${weekly.id}`, { ...weekly, runs: [skipped, sent(2), sent(3)], lastRunAt: sent(2).at, lastOutcome: skipped.message });
  }
  await services.alerts.create({ environment: "demo", instrument: "AAPL", condition: "day_move", percent: 3, note: "Big day" }, lastWeek);
  await services.alerts.create({ environment: "demo", instrument: "NVDA", condition: "day_move", percent: 5 }, lastWeek);
  await services.alerts.check().catch((error: unknown) => console.warn("Could not check the alerts:", error));
  // Account alerts: a fall in value well below today's, cash building up, and the day's move, checked once.
  const summary = await services.trading.accountSummary("demo");
  const total = summary.totalValue ?? 0, cash = summary.cash?.availableToTrade ?? 0;
  if (total > 0) await services.accountAlerts.create({ environment: "demo", condition: "value_below", amount: Math.round((total * 0.9) / 100) * 100, note: "Review the stops" }, lastWeek);
  await services.accountAlerts.create({ environment: "demo", condition: "cash_above", amount: Math.max(100, Math.floor(cash / 2 / 100) * 100), note: "Invest the cash" }, lastWeek);
  await services.accountAlerts.create({ environment: "demo", condition: "day_move", percent: 2 }, lastWeek);
  await services.accountAlerts.check().catch((error: unknown) => console.warn("Could not check the account alerts:", error));
}

/** Journal notes on the two newest sample Apple buys and one without an order, so the holding page shows the journal. */
async function seedJournal(): Promise<void> {
  const history = await client.callTool({ name: "get_trade_history", arguments: { period: "all", limit: 50 } });
  const fills = ((history.structuredContent as { fills?: Array<{ orderId?: string; ticker?: string; side?: string }> } | undefined)?.fills ?? []).filter((fill) => fill.orderId);
  // The nth newest fill of an instrument on one side, newest first.
  const pick = (ticker: string, side: "BUY" | "SELL", nth = 0) => fills.filter((fill) => fill.ticker === ticker && String(fill.side).toUpperCase() === side)[nth];
  const on = (ticker: string, side: "BUY" | "SELL", nth: number, note: Record<string, unknown>) => {
    const fill = pick(ticker, side, nth);
    return fill ? [{ instrument: ticker, orderId: fill.orderId, ...note }] : [];
  };
  const notes: Record<string, unknown>[] = [
    ...on("AAPL_US_EQ", "BUY", 1, { thesis: "Started a position after the earnings beat; adding in thirds so one bad week does not set the price.", tags: ["earnings"] }),
    ...on("NVDA_US_EQ", "SELL", 0, { thesis: "Took profit after the stock doubled; it had grown past a fifth of the portfolio.", review: "Sold too early: the price kept rising. Next time trail a stop instead of selling outright.", tags: ["trim"] }),
    ...on("TSLA_US_EQ", "BUY", 0, { thesis: "Small speculative position on the robotaxi launch; sized so losing it all would not matter.", tags: ["theme"] }),
    ...on("KO_US_EQ", "SELL", 0, { thesis: "Selling part: the yield fell under 3% after the run-up; rotating into the world ETF.", tags: ["income", "trim"] }),
    ...on("NVDA_US_EQ", "BUY", 0, { thesis: "Data-centre spending keeps beating forecasts; buying while guidance is still being raised.", review: "Worked, but the position grew too large. Set a weight cap before adding next time.", tags: ["theme"] }),
    ...on("MSFT_US_EQ", "BUY", 0, { thesis: "Cloud growth is speeding up again; the next quarter's Azure numbers decide whether I add.", tags: ["earnings"] }),
    ...on("AAPL_US_EQ", "BUY", 0, { thesis: "Services keep growing faster than hardware, and the pullback brought the price back to its 200-day average. Wrong if margins shrink next quarter.", review: "Margins held and the price recovered within weeks. Buying the pullback in two steps worked better than one order.", tags: ["pullback", "long-term"] }),
    { instrument: "AAPL", thesis: "Watching the next earnings: add if services growth stays above 10%.", tags: ["earnings", "watchlist"] },
  ];
  for (const note of notes) {
    const outcome = await client.callTool({ name: "manage_trade_journal", arguments: { action: "add", ...note } });
    if (outcome.isError) console.warn("Could not seed the journal:", JSON.stringify(outcome.content).slice(0, 200));
  }
}

/**
 * Six months of made-up daily values ending at today's sample value, so the performance tab shows its chart: the
 * benchmark fund's daily moves, a little more of them, plus the account's own, a dip two thirds of the way in, and the
 * 500 taken out ninety days ago. Weekends do not move, as an account of shares does not, so its risk reads like one.
 */
async function seedValueHistory(): Promise<void> {
  const account = await services.trading.accountSummary("demo");
  const total = account.totalValue ?? 0;
  if (!(total > 0)) return;
  const days = 180;
  const day = 86_400_000;
  const today = Date.now();
  // The fund's simulated closes, read as the comparison reads them (a year back from the start of today).
  const fund = (await services.trading.instruments("demo")).find((item) => item.ticker === config.benchmark);
  const read = fund
    ? await services.priceHistory({ instrument: fund, from: new Date(Math.floor(today / day) * day - 365 * day), quote: services.trading.externalQuote(fund).then((quote) => quote?.price).catch(() => undefined) })
    : undefined;
  const closes = read && "prices" in read ? read.prices.points : [];
  const market = (date: string) => Math.log(closes.filter((point) => point.date <= date).at(-1)?.close ?? 1);
  // A seeded walk, so every start of the preview draws the same days.
  let seed = 212;
  const random = () => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fff_ffff; return seed / 2_147_483_648; };
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const dates = Array.from({ length: days }, (_, index) => new Date(today - (days - 1 - index) * day));
  const weekend = (at: Date) => at.getUTCDay() === 0 || at.getUTCDay() === 6;
  const walk = [0];
  for (let index = 1; index < days; index++) {
    const date = dates[index]!.toISOString().slice(0, 10), before = dates[index - 1]!.toISOString().slice(0, 10);
    walk.push(walk[index - 1]! + (weekend(dates[index]!) ? 0 : 1.1 * (market(date) - market(before)) + 0.004 * normal()));
  }
  // A 12% rise over the six months whatever the fund did, spread over the weekdays, and the dip; today's is the value now.
  const weekdays = dates.slice(1).filter((at) => !weekend(at)).length;
  const drift = (Math.log(1.12) - walk[days - 1]!) / weekdays;
  // The dip moves on weekdays only, holding over a weekend.
  const path: number[] = [];
  let drifted = 0, dip = 0;
  for (let index = 0; index < days; index++) {
    if (index === 0 || !weekend(dates[index]!)) dip = -0.04 * Math.exp(-(((index / (days - 1) - 0.66) / 0.04) ** 2));
    if (index > 0 && !weekend(dates[index]!)) drifted += drift;
    path.push(walk[index]! + drifted + dip);
  }
  for (let index = 0; index < days; index++) {
    const offset = path[index]! - path[days - 1]!;
    // The sample account took out 500 ninety days ago, so the days before held that much more.
    const ago = days - 1 - index;
    const value = round(total * Math.exp(offset) + (ago > 90 ? 500 : 0));
    // The free cash held, and the 500 too before it was taken out: the Income tab's cash rate is over these days.
    const cash = typeof account.cash?.availableToTrade === "number" ? { cash: round(account.cash.availableToTrade + (ago > 90 ? 500 : 0)) } : {};
    const at = dates[index]!;
    await services.values.record("demo", { date: at.toISOString().slice(0, 10), totalValue: value, ...cash, at: at.toISOString(), ...(typeof account.id === "number" ? { account: account.id } : {}) });
  }
}

/** Moves the sample watchlist's entries back in time, each at its simulated close of that day, so the rows show a change since added. */
async function backdateWatchlist(): Promise<void> {
  const daysAgo = [21, 64, 9, 120, 40];
  const day = 86_400_000;
  const from = new Date(Math.floor(Date.now() / day) * day - 365 * day);
  const instruments = await services.trading.instruments("demo");
  for (const [index, item] of (await services.watchlist.list("demo")).entries()) {
    const instrument = instruments.find((entry) => entry.ticker === item.ticker);
    if (!instrument || !item.addedPrice) continue;
    const read = await services.priceHistory({ instrument, from, quote: Promise.resolve(item.addedPrice) });
    if (!("prices" in read)) continue;
    const when = new Date(Date.now() - (daysAgo[index % daysAgo.length]! * day));
    const close = read.prices.points.filter((point) => point.date <= when.toISOString().slice(0, 10)).at(-1);
    if (close) await store.put(watchKey("demo", item.ticker), { ...item, addedAt: `${close.date}T14:30:00.000Z`, addedPrice: close.close });
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
if (!demo) { await seedSample(); await seedJournal(); await seedValueHistory(); await backdateWatchlist(); }
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
    if (request.method === "POST" && url.pathname === "/__notify") {
      const { text } = await readJson(request) as { text?: unknown };
      console.log(`Notification: ${String(text)}`);
      return send(response, 204, "text/plain", "");
    }
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
