// Browser side of `pnpm preview`: a minimal MCP Apps host. It renders the widget in a sandboxed iframe,
// hands it a tool result, and forwards the widget's own tool calls to the preview server.

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { HOST_STYLES } from "./host-styles";

interface Scenario {
  id: string;
  group: string;
  tool: string;
  args: Record<string, unknown>;
  prompt: { en: string; zh: string };
}

interface Boot {
  token: string;
  mode: "sample" | "demo";
  scenarios: Scenario[];
}

interface ToolOutcome {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Theme = "light" | "dark";
type Lang = "en" | "zh-CN";
type Width = "375" | "720" | "1040";
type DisplayMode = "inline" | "fullscreen";

const boot = (window as unknown as { PREVIEW: Boot }).PREVIEW;
const $ = (id: string) => document.getElementById(id)!;
const viewSelect = $("view-select") as unknown as HTMLSelectElement;

const copy = {
  en: {
    title: "TradePilot preview", sample: "Sample account", demo: "Your Demo account", view: "View", theme: "Theme", light: "Light", dark: "Dark",
    language: "Language", width: "Width", phone: "Phone", chat: "Chat", wide: "Wide", host: "Host styles", hostNone: "None", hostGiven: "Given",
    portfolio: "Portfolio", orders: "Orders", pies: "Pies", automation: "Automation",
    modelText: "What the model reads", calls: "Calls from the widget", none: "None yet.", loading: "Loading…", failed: "The tool call failed.",
    exitFullscreen: "Exit full screen (Esc)",
    footSample: "Simulated EUR account. Orders fill against it and nothing is sent to Trading 212. Restart the preview to start fresh.",
    footDemo: "Your Trading 212 Demo account. Confirmed orders go to the practice account. Live is switched off here.",
    footShared: "Plans, alerts and journal notes you create are kept in memory; plans and alerts never run on their own.",
  },
  "zh-CN": {
    title: "TradePilot 预览", sample: "样例账户", demo: "你的 Demo 账户", view: "页面", theme: "主题", light: "浅色", dark: "深色",
    language: "语言", width: "宽度", phone: "手机", chat: "聊天", wide: "宽屏", host: "宿主样式", hostNone: "无", hostGiven: "提供",
    portfolio: "组合", orders: "下单", pies: "Pies", automation: "自动化",
    modelText: "模型读到的文字", calls: "界面发出的调用", none: "暂无。", loading: "加载中…", failed: "工具调用失败。",
    exitFullscreen: "退出全屏（Esc）",
    footSample: "模拟的 EUR 账户。订单在本地成交，不会发到 Trading 212。重启预览即恢复初始数据。",
    footDemo: "你的 Trading 212 Demo 模拟账户。确认后的订单会发到模拟账户。这里不会使用 Live。",
    footShared: "新建的定投计划、价格提醒和交易日志只保存在内存里；计划和提醒不会自动执行。",
  },
} as const;

const labels: Record<string, { en: string; zh: string }> = {
  dashboard: { en: "Dashboard", zh: "总览" },
  allocation: { en: "Allocation", zh: "配置分析" },
  performance: { en: "Performance", zh: "收益表现" },
  income: { en: "Income", zh: "股息收入" },
  tradeplan: { en: "Trade ideas", zh: "交易思路" },
  holding: { en: "One holding", zh: "单只持仓" },
  journal: { en: "Trade journal", zh: "交易日志" },
  review: { en: "Journal review", zh: "日志复盘" },
  watchlist: { en: "Watchlist", zh: "自选" },
  trades: { en: "Trades", zh: "成交记录" },
  tradesnvda: { en: "Trades, one instrument", zh: "单个标的的成交" },
  cash: { en: "Cash movements", zh: "资金流水" },
  taxyear: { en: "Tax year", zh: "税年" },
  orderstatus: { en: "Order status", zh: "订单状态" },
  exports: { en: "CSV reports", zh: "CSV 报表" },
  rules: { en: "Trading rules", zh: "交易规则" },
  order: { en: "Order review", zh: "下单确认" },
  risk: { en: "Size by risk", zh: "按止损风险买入" },
  protective: { en: "Stop-loss and take-profit", zh: "止损止盈" },
  stops: { en: "Stops for every holding", zh: "全部持仓补止损" },
  rebalance: { en: "Rebalance", zh: "再平衡" },
  basket: { en: "Order basket", zh: "批量下单" },
  cancel: { en: "Cancel an order", zh: "撤单确认" },
  pies: { en: "Pies", zh: "Pies 列表" },
  pie: { en: "One pie", zh: "单个 Pie" },
  piechange: { en: "Change a pie", zh: "修改 Pie" },
  automation: { en: "Automation", zh: "自动化" },
};

function readState() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = hash.get(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  };
  return {
    view: pick("view", boot.scenarios.map((item) => item.id), boot.scenarios[0]!.id),
    theme: pick<Theme>("theme", ["light", "dark"], prefersDark ? "dark" : "light"),
    lang: pick<Lang>("lang", ["en", "zh-CN"], navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"),
    width: pick<Width>("width", ["375", "720", "1040"], innerWidth < 760 ? "375" : "720"),
    // A host that gives its style variables, or one that gives none (the widget's own fallbacks).
    host: pick<"none" | "given">("host", ["none", "given"], "none"),
  };
}

let state = readState();
let displayMode: DisplayMode = "inline";
let active: { bridge: AppBridge; iframe: HTMLIFrameElement; scenario: Scenario } | null = null;
let generation = 0;
const widgetHtml = fetch("/widget.html").then((response) => response.text());

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-preview-token": boot.token },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<ToolOutcome>;
}

const text = (outcome: ToolOutcome) => (outcome.content ?? []).map((item) => item.text ?? "").filter(Boolean).join("\n\n");

function frameWidth(): number {
  const available = $("chat").clientWidth;
  return Math.max(320, Math.min(Number(state.width), available));
}

function hostContext(): McpUiHostContext {
  return {
    theme: state.theme,
    locale: state.lang,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: displayMode === "fullscreen" ? { width: innerWidth, height: innerHeight } : { width: frameWidth(), maxHeight: 6000 },
    platform: Number(state.width) < 500 ? "mobile" : "web",
    userAgent: "tradepilot-preview",
    ...(state.host === "given" ? { styles: { variables: HOST_STYLES } } : {}),
  };
}

function writeHash(): void {
  const hash = new URLSearchParams({ view: state.view, theme: state.theme, lang: state.lang, width: state.width, host: state.host });
  history.replaceState(null, "", `#${hash}`);
}

function setDisplayMode(mode: DisplayMode): void {
  displayMode = mode;
  document.documentElement.dataset.display = mode;
  if (active) {
    active.iframe.style.width = mode === "fullscreen" ? "100%" : `${frameWidth()}px`;
    active.bridge.setHostContext(hostContext());
  }
}

function renderChrome(): void {
  const t = copy[state.lang];
  const zh = state.lang === "zh-CN";
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = state.lang;
  document.title = t.title;
  $("title").textContent = t.title;
  $("mode").textContent = boot.mode === "demo" ? t.demo : t.sample;
  $("mode").dataset.mode = boot.mode;
  for (const id of ["view", "theme", "language", "width", "host"] as const) $(`label-${id}`).textContent = t[id];
  for (const [id, key] of [["theme-light", "light"], ["theme-dark", "dark"], ["width-375", "phone"], ["width-720", "chat"], ["width-1040", "wide"], ["host-none", "hostNone"], ["host-given", "hostGiven"]] as const) $(id).textContent = t[key];
  $("model-summary").textContent = t.modelText;
  $("exit-fullscreen").setAttribute("aria-label", t.exitFullscreen);
  $("exit-fullscreen").title = t.exitFullscreen;
  $("foot").textContent = `${boot.mode === "demo" ? t.footDemo : t.footSample} ${t.footShared}`;

  const select = viewSelect;
  select.replaceChildren();
  for (const group of ["portfolio", "orders", "pies", "automation"] as const) {
    const items = boot.scenarios.filter((item) => item.group === group);
    if (!items.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = t[group];
    for (const item of items) optgroup.appendChild(new Option(zh ? labels[item.id]?.zh ?? item.id : labels[item.id]?.en ?? item.id, item.id, false, item.id === state.view));
    select.appendChild(optgroup);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set]")) {
    const [key, value] = button.dataset.set!.split(":") as [keyof typeof state, string];
    button.setAttribute("aria-pressed", String(state[key] === value));
  }
  const scenario = boot.scenarios.find((item) => item.id === state.view)!;
  $("prompt").textContent = zh ? scenario.prompt.zh : scenario.prompt.en;
  $("tool").textContent = scenario.tool;
  renderCalls();
}

const calls: string[] = [];
function renderCalls(): void {
  const t = copy[state.lang];
  $("calls-summary").textContent = `${t.calls} (${calls.length})`;
  const list = $("calls");
  list.replaceChildren(...(calls.length ? calls : [t.none]).map((line) => Object.assign(document.createElement("li"), { textContent: line })));
}

async function mount(): Promise<void> {
  const run = ++generation;
  const scenario = boot.scenarios.find((item) => item.id === state.view)!;
  const previous = active;
  active = null;
  if (previous) {
    void previous.bridge.teardownResource({}).catch(() => {}).finally(() => previous.bridge.close());
    previous.iframe.remove();
  }
  calls.length = 0;
  setDisplayMode("inline");
  renderChrome();
  $("text").textContent = copy[state.lang].loading;

  let outcome: ToolOutcome;
  try {
    outcome = await callTool(scenario.tool, scenario.args);
  } catch (error) {
    if (run === generation) $("text").textContent = `${copy[state.lang].failed}\n${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (run !== generation) return;
  $("text").textContent = text(outcome) || "—";

  const iframe = document.createElement("iframe");
  iframe.title = "TradePilot";
  // Real hosts give the widget an opaque origin; so does the preview.
  iframe.sandbox.add("allow-scripts", "allow-forms", "allow-popups", "allow-popups-to-escape-sandbox");
  iframe.style.width = `${frameWidth()}px`;
  iframe.style.height = "640px";
  $("frame").appendChild(iframe);

  const bridge = new AppBridge(null, { name: "tradepilot-preview", version: "1.0.0" }, { openLinks: {}, serverTools: {}, logging: {} }, { hostContext: hostContext() });
  bridge.oncalltool = async (params) => {
    calls.push(params.name);
    renderCalls();
    return await callTool(params.name, params.arguments ?? {}) as never;
  };
  bridge.onsizechange = async ({ height }) => {
    if (height && displayMode === "inline") iframe.style.height = `${Math.ceil(height)}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    setDisplayMode(mode === "fullscreen" ? "fullscreen" : "inline");
    return { mode: displayMode };
  };
  bridge.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  bridge.onmessage = async () => ({});
  bridge.onupdatemodelcontext = async () => ({});
  bridge.onloggingmessage = (message) => console.info("[widget]", message);
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: scenario.args });
    void bridge.sendToolResult(outcome as never);
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = await widgetHtml;
  if (run !== generation) {
    void bridge.close();
    iframe.remove();
    return;
  }
  active = { bridge, iframe, scenario };
}

function update(next: Partial<typeof state>): void {
  // A widget keeps the variables a host gave it, so taking them away starts it again.
  const remount = (next.view !== undefined && next.view !== state.view) || (next.host !== undefined && next.host !== state.host);
  state = { ...state, ...next };
  writeHash();
  renderChrome();
  if (remount) {
    void mount();
  } else if (active) {
    active.iframe.style.width = displayMode === "fullscreen" ? "100%" : `${frameWidth()}px`;
    active.bridge.setHostContext(hostContext());
  }
}

viewSelect.addEventListener("change", () => update({ view: viewSelect.value }));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set]")) {
  button.addEventListener("click", () => {
    const [key, value] = button.dataset.set!.split(":") as [keyof typeof state, string];
    update({ [key]: value });
  });
}
$("exit-fullscreen").addEventListener("click", () => setDisplayMode("inline"));
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && displayMode === "fullscreen") setDisplayMode("inline");
});
addEventListener("resize", () => {
  if (!active) return;
  if (displayMode === "inline") active.iframe.style.width = `${frameWidth()}px`;
  active.bridge.setHostContext(hostContext());
});
addEventListener("hashchange", () => {
  const next = readState();
  if (JSON.stringify(next) !== JSON.stringify(state)) update(next);
});

writeHash();
void mount();
