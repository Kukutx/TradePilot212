import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CancelDraftPayload,
  CancelPreview,
  CredentialStatus,
  DashboardPayload,
  EnrichedTradeCandidate,
  ErrorPayload,
  ExecutionVerificationResult,
  Instrument,
  OrderDraft,
  OrderExecutionResult,
  OrderPreview,
  OrderResolution,
  StructuredError,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts";
import type { AutomationOverview, BasketExecutionResult, BasketLeg, BasketPreview } from "../shared/automation";
import type { HoldingDetail } from "../shared/holding";
import { APP_META } from "../shared/meta";
import { createTranslator, resolveLocale, type MessageKey, type SupportedLocale } from "./i18n";
import { ErrorCard, Icon, SkeletonView } from "./components/common";
import { bookFromPayload, mergeBooks, readSavedBook, saveBook, type InstrumentBook } from "./lib/instruments";
import { envLabel, executionText, fill, formatProblem, verificationText, type ExecutionKind } from "./lib/messages";
import { cancelDescription, ConfirmModal, OrderConfirmation, OrderEditor } from "./views/OrderViews";
import { PortfolioView } from "./views/PortfolioView";
import { AllocationView, IncomeView, PerformanceView, type InsightPeriod } from "./views/InsightsView";
import type { AllocationAnalysis, IncomeSummary, PerformanceSummary } from "../shared/history";
import { TradePlanView } from "./views/TradePlanView";
import { BasketView, type BasketDraftView } from "./views/BasketView";
import { PieChangeView, PiesView } from "./views/PiesView";
import { AutomationView } from "./views/AutomationView";
import { HoldingView } from "./views/HoldingView";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PiesPayload } from "../shared/pies";

type BasePayload =
  | DashboardPayload
  | TradePlanPayload
  | {
      kind: "order_draft";
      draft: OrderDraft;
      credentials: CredentialStatus;
      writeEnabled?: boolean;
      resolvedInstrument?: Instrument;
      resolution?: OrderResolution;
    }
  | InsightPayload
  | BasketDraftView
  | PiesPayload
  | AutomationOverview
  | PieChangeDraftPayload
  | CancelDraftPayload
  | HoldingDetail
  | ErrorPayload;

type WithAccess<T> = T & { credentials: CredentialStatus; writeEnabled?: boolean };
type InsightPayload = WithAccess<AllocationAnalysis> | WithAccess<PerformanceSummary> | WithAccess<IncomeSummary>;
type InsightKind = InsightPayload["kind"];
type PortfolioTab = "holdings" | InsightKind;
type InsightCache = { allocation?: WithAccess<AllocationAnalysis>; performance?: WithAccess<PerformanceSummary>; income?: WithAccess<IncomeSummary> };

/** A failed action: a title naming what failed, the reason, and a way to try again when that is safe. */
interface Problem {
  title: MessageKey;
  message: string;
  code?: StructuredError["code"];
  retry?: () => void;
}

const INSIGHT_TOOLS: Record<InsightKind, string> = {
  allocation: "analyze_portfolio_allocation",
  performance: "get_portfolio_performance",
  income: "get_income_summary",
};
const TAB_KEYS: Record<PortfolioTab, MessageKey> = { holdings: "tabHoldings", allocation: "tabAllocation", performance: "tabPerformance", income: "tabIncome" };

function periodOf(range: { from?: string; to: string }): InsightPeriod {
  if (!range.from) return "all";
  const from = new Date(range.from);
  return from.getUTCMonth() === 0 && from.getUTCDate() === 1 && from.getUTCHours() === 0 ? "ytd" : "1y";
}
const isInsight = (payload: BasePayload | null): payload is InsightPayload =>
  payload?.kind === "allocation" || payload?.kind === "performance" || payload?.kind === "income";

type Status = "idle" | "loading";
type DisplayMode = "inline" | "fullscreen" | "pip";
const LOCALE_STORAGE_KEY = "tradepilot212.locale";

function readSavedLocale(): SupportedLocale | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === "zh-CN" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

class ToolCallError extends Error {
  constructor(readonly problem: StructuredError) {
    super(problem.message);
    this.name = "ToolCallError";
  }
}

function textFromToolResult(value: Awaited<ReturnType<McpApp["callServerTool"]>>): string {
  return (
    value.content
      ?.filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join(" ") || "Tool request failed"
  );
}

function candidateForRefresh(candidate: EnrichedTradeCandidate): TradeCandidate {
  return {
    ...(candidate.ticker ? { ticker: candidate.ticker } : {}),
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    ...(candidate.name ? { name: candidate.name } : {}),
    horizon: candidate.horizon,
    action: candidate.action,
    score: candidate.score,
    rationale: candidate.rationale,
    risk: candidate.risk,
    ...(candidate.suggestedQuantity ? { suggestedQuantity: candidate.suggestedQuantity } : {}),
    ...(candidate.referencePrice ? { referencePrice: candidate.referencePrice } : {}),
    ...(candidate.referencePriceAt ? { referencePriceAt: candidate.referencePriceAt } : {}),
    ...(candidate.analysisAsOf ? { analysisAsOf: candidate.analysisAsOf } : {}),
    ...(candidate.thesis ? { thesis: candidate.thesis } : {}),
    ...(candidate.catalysts ? { catalysts: candidate.catalysts } : {}),
    ...(candidate.risks ? { risks: candidate.risks } : {}),
    ...(candidate.counterCase ? { counterCase: candidate.counterCase } : {}),
    ...(candidate.sources ? { sources: candidate.sources } : {}),
  };
}

function initialEnvironment(payload: BasePayload | null): TradingEnvironment {
  if (!payload) return "demo";
  // A missing API key names the environment that was asked for.
  if (payload.kind === "error") return payload.error.details?.environment === "live" ? "live" : "demo";
  if (payload.kind === "order_draft" || payload.kind === "pie_change_draft") return payload.draft.environment;
  return payload.environment;
}

function defaultDraft(
  environment: TradingEnvironment,
  candidate: EnrichedTradeCandidate,
): OrderDraft | null {
  const ticker = candidate.resolvedInstrument?.ticker ?? candidate.ticker;
  if (!ticker || candidate.action === "watch") return null;
  return {
    environment,
    ticker,
    side: candidate.action,
    type: "market",
    quantity: candidate.suggestedQuantity ?? 1,
    ...(candidate.referencePrice ? { referencePrice: candidate.referencePrice } : {}),
    ...(candidate.referencePriceAt ? { referencePriceAt: candidate.referencePriceAt } : {}),
  };
}

/** The account the current view needs is not connected: say how to connect it instead of showing an empty account. */
function SetupCard({ environment, credentials, t, busy, onSwitch }: { environment: TradingEnvironment; credentials: CredentialStatus; t: (key: MessageKey) => string; busy: boolean; onSwitch: (next: TradingEnvironment) => void }) {
  const env = envLabel(environment, t);
  const prefix = `T212_${environment.toUpperCase()}_API`;
  const other: TradingEnvironment = environment === "live" ? "demo" : "live";
  return (
    <main className="contentStack">
      <section className={`stateCard setupCard ${environment}`} aria-labelledby="setup-title">
        <Icon name="alert" />
        <div className="stateCopy">
          <h2 id="setup-title">{fill(t("setupTitle"), { env })}</h2>
          <p>{fill(t("setupBody"), { env, key: `${prefix}_KEY`, secret: `${prefix}_SECRET` })}</p>
        </div>
        {credentials[other] && <button type="button" className="secondaryButton" disabled={busy} onClick={() => onSwitch(other)}>{fill(t("setupSwitch"), { env: envLabel(other, t) })}</button>}
      </section>
    </main>
  );
}

/** Nothing to show and nothing failed: say so, with a way to load it again. */
function EmptyRetry({ text, retryLabel, onRetry }: { text: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="emptyState withAction">
      <span>{text}</span>
      <button type="button" className="secondaryButton" onClick={onRetry}>{retryLabel}</button>
    </div>
  );
}

/** View tabs that scroll on narrow widths: the active tab is kept in view and fading edges show there is more. */
function ViewTabs({ tab, busy, t, onSelect }: { tab: PortfolioTab; busy: boolean; t: (key: MessageKey) => string; onSelect: (next: PortfolioTab) => void }) {
  const nav = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = nav.current;
    if (!element) return;
    const update = () => setEdges({ start: element.scrollLeft > 2, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => { element.removeEventListener("scroll", update); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    const element = nav.current;
    const active = element?.querySelector<HTMLElement>("[aria-current='page']");
    if (!element || !active || element.scrollWidth <= element.clientWidth) return;
    const left = active.offsetLeft - (element.clientWidth - active.offsetWidth) / 2;
    element.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [tab]);
  return (
    <div className={`tabStrip${edges.start ? " fadeStart" : ""}${edges.end ? " fadeEnd" : ""}`}>
      <nav className="viewTabs" aria-label={t("viewsLabel")} ref={nav}>
        {(["holdings", "allocation", "performance", "income"] as const).map((key) => (
          <button key={key} type="button" aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : ""} disabled={busy && tab !== key} onClick={() => onSelect(key)}>
            {t(TAB_KEYS[key])}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [base, setBase] = useState<BasePayload | null>(null);
  // The dashboard a holding was opened from, so Back returns to it without a new read.
  const [holdingFrom, setHoldingFrom] = useState<DashboardPayload | null>(null);
  const [tab, setTab] = useState<PortfolioTab>("holdings");
  const [insights, setInsights] = useState<InsightCache>({});
  const [insightError, setInsightError] = useState<{ kind: InsightKind; problem: Problem } | null>(null);
  const [period, setPeriod] = useState<InsightPeriod>("ytd");
  const [environment, setEnvironment] = useState<TradingEnvironment>("demo");
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [cancelDraftClosed, setCancelDraftClosed] = useState(false);
  const [execution, setExecution] = useState<OrderExecutionResult | null>(null);
  const [executionKind, setExecutionKind] = useState<ExecutionKind>("order");
  const [verification, setVerification] = useState<ExecutionVerificationResult | null>(null);
  const [basketLegs, setBasketLegs] = useState<BasketLeg[]>([]);
  const [basketPreview, setBasketPreview] = useState<BasketPreview | null>(null);
  const [basketResult, setBasketResult] = useState<BasketExecutionResult | null>(null);
  const [basketVerifications, setBasketVerifications] = useState<Record<string, ExecutionVerificationResult>>({});
  const [piePreview, setPiePreview] = useState<PieChangePreview | null>(null);
  const [pieResult, setPieResult] = useState<PieChangeResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [book, setBook] = useState<InstrumentBook>(() => readSavedBook());
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    readSavedLocale() ?? resolveLocale(typeof navigator === "undefined" ? "en" : navigator.language),
  );
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [availableDisplayModes, setAvailableDisplayModes] = useState<DisplayMode[]>(["inline"]);
  const cancelDraftRequested = useRef<string | null>(null);

  const t = useMemo(() => createTranslator(locale), [locale]);

  /** Remember instrument names from every payload, so later views can name what they only know by ticker. */
  const learn = (payload: unknown) => {
    const found = bookFromPayload(payload);
    if (!Object.keys(found).length) return;
    setBook((current) => {
      const next = mergeBooks(current, found);
      saveBook(next);
      return next;
    });
  };

  const syncHostContext = (context: ReturnType<McpApp["getHostContext"]>) => {
    if (!context) return;
    if (context.displayMode) setDisplayMode(context.displayMode as DisplayMode);
    if (context.availableDisplayModes) setAvailableDisplayModes(context.availableDisplayModes as DisplayMode[]);
    if (context.locale && !readSavedLocale()) setLocale(resolveLocale(context.locale));
  };

  const { app, error } = useApp({
    appInfo: { name: APP_META.name, version: APP_META.version },
    capabilities: {},
    onAppCreated: (createdApp: McpApp) => {
      // Change notifications carry only the fields that changed; the full context arrives with the
      // connection, so it is read once the app is connected (below).
      createdApp.onhostcontextchanged = syncHostContext;
      createdApp.ontoolresult = (toolResult) => {
        const payload = toolResult.structuredContent as unknown as BasePayload;
        if (payload) showPayload(payload);
      };
    },
  });

  /** Show a tool result as the widget's main view, as when the host hands one over. Uses only state setters and refs. */
  function showPayload(payload: BasePayload): void {
    learn(payload);
    setBase(payload);
    // A page the host hands over starts fresh: Back from a holding then reads the dashboard again.
    setHoldingFrom(null);
    setProblem(null);
    setInsightError(null);
    const env = initialEnvironment(payload);
    setEnvironment(env);
    if (isInsight(payload)) {
      setInsights({ [payload.kind]: payload });
      setTab(payload.kind);
      if (payload.kind !== "allocation") setPeriod(periodOf(payload.period));
    } else if (payload.kind === "portfolio") {
      setInsights({});
      setTab("holdings");
    }
    if (payload.kind === "order_draft") setDraft(payload.draft);
    if (payload.kind === "pie_change_draft") {
      setPiePreview(null);
      setPieResult(null);
    }
    if (payload.kind === "basket_draft") {
      setBasketLegs(payload.legs ?? []);
      setBasketPreview(null);
      setBasketResult(null);
      setBasketVerifications({});
      setExecution(null);
    }
    if (payload.kind === "cancel_draft") {
      cancelDraftRequested.current = null;
      setCancelDraftClosed(false);
      setCancelPreview(null);
      setExecution(null);
    }
  }

  useHostStyles(app, app?.getHostContext());
  // The host's initial context (locale, display modes) is only available after connecting.
  useEffect(() => {
    if (app) syncHostContext(app.getHostContext());
  }, [app]);

  // Reviews stay inline: the widget never asks for fullscreen on its own, only from the Full view button.
  const cancelDraftActive = base?.kind === "cancel_draft" && !cancelDraftClosed;
  const transactionActive = Boolean(draft || preview || cancelPreview || cancelDraftActive);
  const basketActive = (base?.kind === "basket_draft" || base?.kind === "pie_change_draft") && !transactionActive;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (error) setProblem({ title: "errorTitleConnection", message: error.message });
  }, [error]);

  const credentials: CredentialStatus = useMemo(() => {
    if (!base) return { demo: false, live: false };
    // A missing API key says which environments are set up, so the setup card can offer the other one.
    if (base.kind === "error") return { demo: base.error.details?.demo === true, live: base.error.details?.live === true };
    return base.credentials;
  }, [base]);

  const writeEnabled = base && base.kind !== "error" ? base.writeEnabled !== false : false;
  const connected = Boolean(base && base.kind !== "error" && credentials[environment]);

  function changeLocale(next: SupportedLocale) {
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Sandboxed hosts may disable localStorage; host locale remains the fallback.
    }
  }

  async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!app) throw new Error("ChatGPT app connection is not ready");
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const payload = result.structuredContent as unknown as ErrorPayload | undefined;
      if (payload?.kind === "error" && payload.error) throw new ToolCallError(payload.error);
      throw new ToolCallError({ code: "INTERNAL_ERROR", message: textFromToolResult(result) });
    }
    learn(result.structuredContent);
    return result.structuredContent as unknown as T;
  }

  function problemFrom(title: MessageKey, value: unknown, retry?: () => void): Problem {
    const message = value instanceof ToolCallError ? formatProblem(value.problem, t, locale) : value instanceof Error ? value.message : String(value);
    return { title, message, ...(value instanceof ToolCallError ? { code: value.problem.code } : {}), ...(retry ? { retry } : {}) };
  }

  /** Runs one widget action with the shared busy state; a failure is reported under the action's own title. */
  async function run(title: MessageKey, action: () => Promise<void>, retry?: () => void): Promise<boolean> {
    setStatus("loading");
    setProblem(null);
    try {
      await action();
      return true;
    } catch (requestError) {
      setProblem(problemFrom(title, requestError, retry));
      return false;
    } finally {
      setStatus("idle");
    }
  }

  /** Plan a rebalance from the saved targets; the trades open as a basket to review, nothing is sent. */
  async function rebalanceToTargets(buyOnly = false): Promise<void> {
    await run("errorTitleRebalance", async () => {
      showPayload(await callTool<BasePayload>("plan_portfolio_rebalance", { environment, ...(buyOnly ? { buyOnly } : {}) }));
    }, () => void rebalanceToTargets(buyOnly));
  }

  /** Draft a stop for every holding without a full one; they open as a basket to review, nothing is sent. */
  async function protectAll(): Promise<void> {
    await run("errorTitleStops", async () => {
      showPayload(await callTool<BasePayload>("review_portfolio_stops", { environment }));
    }, () => void protectAll());
  }

  async function loadInsight(kind: InsightKind, env = environment, range = period): Promise<void> {
    setStatus("loading");
    setProblem(null);
    setInsightError(null);
    try {
      const args = kind === "allocation" ? { environment: env } : { environment: env, period: range };
      const payload = await callTool<InsightPayload>(INSIGHT_TOOLS[kind], args);
      setInsights((current) => ({ ...current, [kind]: payload }));
    } catch (requestError) {
      const retry = () => void loadInsight(kind, env, range);
      const failure = problemFrom("errorTitleLoad", requestError, retry);
      // With nothing to show, the error takes the view's place; otherwise the older data stays below it.
      if (insights[kind]) setProblem(failure);
      else setInsightError({ kind, problem: failure });
    } finally {
      setStatus("idle");
    }
  }

  async function selectTab(next: PortfolioTab): Promise<void> {
    setTab(next);
    if (next === "holdings") {
      if (base?.kind !== "portfolio" || base.environment !== environment) await refresh(environment, "holdings");
      return;
    }
    if (!insights[next]) await loadInsight(next);
  }

  async function changePeriod(next: InsightPeriod): Promise<void> {
    setPeriod(next);
    if (tab === "performance" || tab === "income") await loadInsight(tab, environment, next);
  }

  async function refresh(env = environment, target: PortfolioTab = tab): Promise<void> {
    if (target !== "holdings" && base?.kind !== "trade_plan" && base?.kind !== "automation" && base?.kind !== "pies" && base?.kind !== "holding") return loadInsight(target, env);
    await run("errorTitleRefresh", async () => {
      if (base?.kind === "holding") {
        setBase(await callTool<HoldingDetail>("app_get_holding", { environment: env, instrument: base.ticker }));
      } else if (base?.kind === "automation") {
        setBase(await callTool<AutomationOverview>("app_get_automation", { environment: env }));
      } else if (base?.kind === "pies") {
        setBase(await callTool<PiesPayload>("app_list_pies", { environment: env }));
      } else if (base?.kind === "trade_plan") {
        setBase(await callTool<TradePlanPayload>("app_get_trade_plan", {
          environment: env,
          candidates: base.candidates.map(candidateForRefresh),
        }));
      } else {
        setBase(await callTool<DashboardPayload>("app_get_dashboard", { environment: env }));
        setTab("holdings");
      }
    }, () => void refresh(env, target));
  }

  /** Create, delete or re-arm a price alert, then read the page again so it shows the change. Alerts never trade. */
  async function changeAlert(input: Record<string, unknown>): Promise<boolean> {
    const done = await run("errorTitleAlert", async () => {
      await callTool("manage_price_alerts", { environment, ...input });
    });
    if (done) await refresh(environment, "holdings");
    return done;
  }

  /** Open one holding's detail from the dashboard; Back shows that dashboard again. */
  async function openHolding(ticker: string): Promise<void> {
    await run("errorTitleLoad", async () => {
      const detail = await callTool<HoldingDetail>("app_get_holding", { environment, instrument: ticker });
      setHoldingFrom(base?.kind === "portfolio" ? base : null);
      setBase(detail);
    }, () => void openHolding(ticker));
  }

  async function backFromHolding(): Promise<void> {
    if (holdingFrom && holdingFrom.environment === environment) {
      setBase(holdingFrom);
      setHoldingFrom(null);
      setTab("holdings");
      return;
    }
    setHoldingFrom(null);
    await run("errorTitleRefresh", async () => {
      setBase(await callTool<DashboardPayload>("app_get_dashboard", { environment }));
      setTab("holdings");
    }, () => void backFromHolding());
  }

  async function switchEnvironment(next: TradingEnvironment): Promise<void> {
    if (next === environment) return;
    setEnvironment(next);
    setExecution(null);
    setVerification(null);
    setPreview(null);
    setCancelPreview(null);
    setBasketPreview(null);
    setBasketResult(null);
    setInsights({});
    setInsightError(null);
    if (draft) setDraft({ ...draft, environment: next });
    if (base?.kind === "order_draft") {
      setBase({ ...base, draft: { ...base.draft, environment: next } });
      return;
    }
    await refresh(next);
  }

  async function toggleDisplayMode(): Promise<void> {
    if (!app) return;
    const target: DisplayMode = displayMode === "fullscreen" ? "inline" : "fullscreen";
    if (!availableDisplayModes.includes(target)) return;
    try {
      const result = await app.requestDisplayMode({ mode: target });
      setDisplayMode(result.mode);
    } catch (requestError) {
      setProblem(problemFrom("errorTitleDisplay", requestError));
    }
  }

  async function closeOrderDraft(): Promise<void> {
    setDraft(null);
    setPreview(null);
    setProblem(null);
    if (base?.kind === "order_draft") await refresh(environment, "holdings");
  }

  async function reviewOrder(): Promise<void> {
    if (!draft) return;
    await run("errorTitleOrderCheck", async () => {
      setPreview(await callTool<OrderPreview>("app_prepare_order", draft as unknown as Record<string, unknown>));
    });
  }

  async function confirmOrder(liveAcknowledged = false): Promise<void> {
    if (!preview) return;
    const sent = await run("errorTitleOrderSend", async () => {
      const confirmationCode = preview["token"];
      const result = await callTool<OrderExecutionResult>("app_execute_order", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) });
      setExecution(result);
      setExecutionKind("order");
      setVerification(null);
      setPreview(null);
      setDraft(null);
      // The saved dashboard no longer matches the account; Back from a holding reads it again.
      setHoldingFrom(null);
    });
    if (sent) await refresh(environment, "holdings");
  }

  function resetBasket(): void {
    setBasketLegs([]);
    setBasketPreview(null);
    setBasketResult(null);
    setBasketVerifications({});
  }

  async function closeBasket(): Promise<void> {
    resetBasket();
    setProblem(null);
    await refresh(environment, "holdings");
  }

  async function reviewBasket(): Promise<void> {
    if (base?.kind !== "basket_draft" || basketLegs.length === 0) return;
    await run("errorTitleBasketCheck", async () => {
      setBasketPreview(await callTool<BasketPreview>("app_prepare_basket", {
        environment: base.environment,
        purpose: base.purpose,
        title: base.title,
        drafts: basketLegs.map((leg) => ({ ...leg.draft, environment: base.environment })),
        ...(base.planId ? { planId: base.planId } : {}),
        ...(base.notes?.length ? { notes: base.notes } : {}),
      }));
    });
  }

  async function confirmBasket(liveAcknowledged = false): Promise<void> {
    if (!basketPreview) return;
    setStatus("loading");
    setProblem(null);
    let keepPreview = false;
    try {
      const confirmationCode = basketPreview["token"];
      const result = await callTool<BasketExecutionResult>("app_execute_basket", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) });
      setBasketResult(result);
      setBasketVerifications({});
    } catch (requestError) {
      // The token may already be consumed; never resend it. The person must review again explicitly,
      // unless the server said the send never started because another order was in flight.
      const failure = problemFrom("errorTitleBasketSend", requestError);
      keepPreview = failure.code === "EXECUTION_BUSY" || failure.code === "LIVE_ACK_REQUIRED";
      setProblem(failure);
    } finally {
      if (!keepPreview) setBasketPreview(null);
      setStatus("idle");
    }
  }

  async function closePieChange(): Promise<void> {
    setPiePreview(null);
    setPieResult(null);
    setProblem(null);
    await refresh(environment, "holdings");
  }

  async function reviewPieChange(): Promise<void> {
    if (base?.kind !== "pie_change_draft") return;
    await run("errorTitlePieCheck", async () => {
      setPiePreview(await callTool<PieChangePreview>("app_prepare_pie_change", base.draft as unknown as Record<string, unknown>));
    });
  }

  async function confirmPieChange(liveAcknowledged = false): Promise<void> {
    if (!piePreview) return;
    setStatus("loading");
    setProblem(null);
    let keepPreview = false;
    try {
      const confirmationCode = piePreview["token"];
      setPieResult(await callTool<PieChangeResult>("app_execute_pie_change", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) }));
    } catch (requestError) {
      // The token may already be consumed; never resend it.
      const failure = problemFrom("errorTitlePieSend", requestError);
      keepPreview = failure.code === "EXECUTION_BUSY" || failure.code === "LIVE_ACK_REQUIRED";
      setProblem(failure);
    } finally {
      if (!keepPreview) setPiePreview(null);
      setStatus("idle");
    }
  }

  async function verifyBasketLeg(verificationId: string): Promise<void> {
    await run("errorTitleVerify", async () => {
      const result = await callTool<ExecutionVerificationResult>("app_verify_unknown_execution", { verificationId });
      setBasketVerifications((current) => ({ ...current, [verificationId]: result }));
    });
  }

  async function startCancel(orderId: string, env = environment): Promise<void> {
    await run("errorTitleCancelCheck", async () => {
      setCancelPreview(await callTool<CancelPreview>("app_prepare_cancel", { environment: env, orderId }));
    }, () => void startCancel(orderId, env));
  }

  // A cancellation the model drafted opens straight into its confirmation, prepared the same way as from the dashboard.
  useEffect(() => {
    if (!app || base?.kind !== "cancel_draft" || !base.order || base.writeEnabled === false || cancelDraftClosed) return;
    if (cancelDraftRequested.current === base.orderId) return;
    cancelDraftRequested.current = base.orderId;
    void startCancel(base.orderId, base.environment);
  });

  async function closeCancel(): Promise<void> {
    setCancelPreview(null);
    setProblem(null);
    if (base?.kind === "cancel_draft") {
      setCancelDraftClosed(true);
      await refresh(environment, "holdings");
    }
  }

  async function confirmCancel(liveAcknowledged = false): Promise<void> {
    if (!cancelPreview) return;
    const sent = await run("errorTitleCancelSend", async () => {
      const confirmationCode = cancelPreview["token"];
      const result = await callTool<OrderExecutionResult>("app_execute_cancel", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) });
      setExecution(result);
      setExecutionKind("cancel");
      setVerification(null);
      setCancelPreview(null);
      if (base?.kind === "cancel_draft") setCancelDraftClosed(true);
      setHoldingFrom(null);
    });
    if (sent) await refresh(environment, "holdings");
  }

  async function verifyUnknownExecution(): Promise<void> {
    if (!execution?.verificationId) return;
    const verificationId = execution.verificationId;
    const checked = await run("errorTitleVerify", async () => {
      setVerification(await callTool<ExecutionVerificationResult>("app_verify_unknown_execution", { verificationId }));
      setHoldingFrom(null);
    });
    if (checked) await refresh(environment, "holdings");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cancelPreview || cancelDraftActive) void closeCancel();
      else if (preview) setPreview(null);
      else if (basketPreview && status !== "loading") setBasketPreview(null);
      else if (piePreview && status !== "loading") setPiePreview(null);
      else if (draft) void closeOrderDraft();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  if (!app && !error) {
    return <div className="centerState"><div className="spinner" />{t("connecting")}</div>;
  }

  const canToggleFullscreen = availableDisplayModes.includes("fullscreen") || displayMode === "fullscreen";
  const loading = status === "loading";
  const portfolioLike = base?.kind === "portfolio" || isInsight(base);
  // Views that read an account: without its API key they would only show an empty account.
  const accountView = portfolioLike || base?.kind === "trade_plan" || base?.kind === "pies" || base?.kind === "automation" || base?.kind === "holding";
  const missingCredentials = (accountView && !credentials[environment])
    || (base?.kind === "error" && base.error.code === "CREDENTIALS_NOT_CONFIGURED")
    || (tab !== "holdings" && insightError?.kind === tab && insightError.problem.code === "CREDENTIALS_NOT_CONFIGURED");
  const positions = base?.kind === "portfolio" ? base.positions : [];
  const cancelTarget = cancelPreview ?? (base?.kind === "cancel_draft" && cancelDraftActive ? base : null);
  const fullLabel = displayMode === "fullscreen" ? t("collapse") : t("expand");

  return (
    <div className={`appShell mode-${displayMode}`}>
      <header className="appHeader">
        <div className="brandBlock">
          <div className="brandMark" aria-hidden="true">TP</div>
          <div className="brandCopy">
            <span className="brokerLabel">{t("brokerName")}</span>
            <h1>{t("appName")}</h1>
          </div>
        </div>

        <div className="headerActions">
          <div className="environmentSwitch" role="group" aria-label={t("environment")}>
            {(["demo", "live"] as const).map((env) => (
              <button
                key={env}
                type="button"
                className={`${env === "live" ? "live" : ""}${environment === env ? " active" : ""}`}
                aria-pressed={environment === env}
                title={credentials[env] ? t("credentialsReady") : t("credentialsMissing")}
                onClick={() => void switchEnvironment(env)}
                disabled={loading || basketActive}
              >
                <span className={`statusDot ${credentials[env] ? "ready" : ""}`} aria-hidden="true" />
                {envLabel(env, t)}
                {!credentials[env] && <span className="visuallyHidden"> ({t("credentialsMissing")})</span>}
              </button>
            ))}
          </div>

          <div className="languageSwitch" role="group" aria-label={t("language")}>
            <Icon name="globe" />
            <button type="button" lang="zh-CN" aria-pressed={locale === "zh-CN"} className={locale === "zh-CN" ? "active" : ""} onClick={() => changeLocale("zh-CN")}>中文</button>
            <button type="button" lang="en" aria-pressed={locale === "en"} className={locale === "en" ? "active" : ""} onClick={() => changeLocale("en")}>EN</button>
          </div>

          {canToggleFullscreen && (
            <button className="iconAction" type="button" onClick={() => void toggleDisplayMode()} title={fullLabel} aria-label={fullLabel}>
              <Icon name={displayMode === "fullscreen" ? "collapse" : "expand"} />
              <span className="actionText" aria-hidden="true">{fullLabel}</span>
            </button>
          )}
          <button className="iconAction" type="button" onClick={() => void refresh()} disabled={loading || basketActive || transactionActive} title={t("refresh")} aria-label={loading ? t("refreshing") : t("refresh")} aria-busy={loading}>
            <Icon name="refresh" className={loading ? "spinning" : undefined} />
            <span className="actionText" aria-hidden="true">{loading ? t("refreshing") : t("refresh")}</span>
          </button>
        </div>
      </header>

      <div className={`environmentBar ${environment}`}>
        <div>
          <strong>{environment === "live" ? t("liveMoney") : credentials.sample ? t("sampleAccount") : t("demoAccount")}</strong>
          <span>{environment === "live" ? t("liveDescription") : credentials.sample ? t("sampleDescription") : t("demoDescription")}</span>
        </div>
        {base && <span className={`connectionBadge ${connected ? "" : "missing"}`}><span className={`statusDot ${connected ? "ready" : "missing"}`} aria-hidden="true" />{connected ? t("connected") : t("notConnected")}</span>}
      </div>

      {!writeEnabled && base && base.kind !== "error" && (
        <div className="notice warning"><strong>{t("readonlyMode")}</strong><span>{t("readonlyHint")}</span></div>
      )}
      {problem && (
        <div className="notice error problemNotice" role="alert">
          <div className="noticeCopy"><strong>{t(problem.title)}</strong><span>{problem.message}</span></div>
          {problem.retry && <button type="button" className="secondaryButton" disabled={loading} onClick={problem.retry}>{t("retry")}</button>}
        </div>
      )}
      {execution && (
        <div className={`notice executionNotice ${execution.ok ? "success" : execution.status === "unknown" ? "warning" : "error"}`} role="status" aria-live="polite">
          <div className="noticeCopy">
            <strong>{execution.status === "unknown" ? t("unknownStatus") : execution.ok ? t("submitted") : t("notSubmitted")}</strong>
            <span>{execution.ok ? executionText(executionKind, execution.environment, t) : execution.error ? formatProblem(execution.error, t, locale) : execution.message}</span>
            {verification && <span className="verificationResult">{verificationText(verification, t)}</span>}
          </div>
          {execution.status === "unknown" && execution.verificationId && (
            <button className="secondaryButton" type="button" disabled={loading} onClick={() => void verifyUnknownExecution()}>
              {loading ? t("verifying") : t("verifyExecution")}
            </button>
          )}
        </div>
      )}

      {!transactionActive && !basketActive && (
        missingCredentials ? (
          <SetupCard environment={environment} credentials={credentials} t={t} busy={loading} onSwitch={(next) => void switchEnvironment(next)} />
        ) : (
          <>
            {base?.kind === "error" && <ErrorCard title={t("errorTitleLoad")} message={formatProblem(base.error, t, locale)} retryLabel={t("retry")} busy={loading} onRetry={() => void refresh(environment, "holdings")} />}
            {portfolioLike && <ViewTabs tab={tab} busy={loading} t={t} onSelect={(next) => void selectTab(next)} />}
            {base?.kind === "portfolio" && tab === "holdings" && (
              <PortfolioView payload={base} book={book} locale={locale} t={t} writeEnabled={writeEnabled} busy={loading} onCancel={(id) => void startCancel(id)} onOpen={(ticker) => void openHolding(ticker)}
                {...(writeEnabled && connected ? { onProtectAll: () => void protectAll() } : {})} />
            )}
            {base && isInsight(base) && tab === "holdings" && (loading
              ? <SkeletonView label={t("refreshing")} />
              : <EmptyRetry text={t("nothingLoaded")} retryLabel={t("retry")} onRetry={() => void refresh(environment, "holdings")} />)}
            {tab !== "holdings" && portfolioLike && !insights[tab] && (
              loading ? <SkeletonView label={t("loadingInsights")} />
                : insightError?.kind === tab ? <ErrorCard title={t(insightError.problem.title)} message={insightError.problem.message} retryLabel={t("retry")} busy={loading} {...(insightError.problem.retry ? { onRetry: insightError.problem.retry } : {})} />
                : <EmptyRetry text={t("noData")} retryLabel={t("retry")} onRetry={() => void loadInsight(tab)} />
            )}
            {tab === "allocation" && insights.allocation && (
              <AllocationView data={insights.allocation} book={book} locale={locale} t={t} busy={loading}
                {...(insights.allocation.drift && writeEnabled && connected ? { onRebalance: () => void rebalanceToTargets(), onInvestCash: () => void rebalanceToTargets(true) } : {})} />
            )}
            {tab === "performance" && insights.performance && (
              <PerformanceView data={insights.performance} book={book} locale={locale} t={t} period={period} busy={loading} onPeriod={(next) => void changePeriod(next)} />
            )}
            {tab === "income" && insights.income && (
              <IncomeView data={insights.income} book={book} locale={locale} t={t} period={period} busy={loading} onPeriod={(next) => void changePeriod(next)} />
            )}
            {base?.kind === "trade_plan" && (
              <TradePlanView
                payload={base}
                book={book}
                locale={locale}
                t={t}
                writeEnabled={writeEnabled}
                onTrade={(candidate) => {
                  const next = defaultDraft(environment, candidate);
                  if (!next) return;
                  setDraft(next);
                  setPreview(null);
                  setExecution(null);
                }}
              />
            )}
            {base?.kind === "holding" && (
              <HoldingView
                data={base}
                book={book}
                locale={locale}
                t={t}
                writeEnabled={writeEnabled}
                busy={loading}
                onBack={() => void backFromHolding()}
                onSaveAlert={(request) => changeAlert({ action: "create", instrument: base.ticker, ...request })}
                onDeleteAlert={(alertId) => void changeAlert({ action: "delete", alertId })}
                onRearmAlert={(alertId) => void changeAlert({ action: "rearm", alertId })}
                onCancel={(id) => void startCancel(id)}
                onTrade={(side) => {
                  // One share to start; the editor changes the size and type before anything is reviewed.
                  const available = base.position?.quantityAvailableForTrading ?? 0;
                  setDraft({ environment, ticker: base.ticker, side, type: "market", quantity: side === "sell" ? Math.min(1, available) || available : 1 });
                  setPreview(null);
                  setExecution(null);
                }}
                onProtect={({ quantity, stopPrice }) => {
                  // A good-till-cancelled sell stop for the uncovered shares; the editor and review come before anything is sent.
                  setDraft({ environment, ticker: base.ticker, side: "sell", type: "stop", quantity, stopPrice, timeValidity: "GOOD_TILL_CANCEL" });
                  setPreview(null);
                  setExecution(null);
                }}
              />
            )}
            {base?.kind === "pies" && <PiesView payload={base} book={book} locale={locale} t={t} />}
            {base?.kind === "automation" && (
              <AutomationView data={base} book={book} locale={locale} t={t} busy={loading}
                onDeleteAlert={(alertId) => void changeAlert({ action: "delete", alertId })}
                onRearmAlert={(alertId) => void changeAlert({ action: "rearm", alertId })} />
            )}
            {base?.kind === "order_draft" && !draft && (loading ? <SkeletonView label={t("refreshing")} /> : <div className="emptyState">{t("orderLoaded")}</div>)}
            {base?.kind === "cancel_draft" && (loading
              ? <SkeletonView label={t("refreshing")} />
              : <EmptyRetry text={t("nothingLoaded")} retryLabel={t("retry")} onRetry={() => void refresh(environment, "holdings")} />)}
            {!base && <div className="emptyState">{t("waiting")}</div>}
          </>
        )
      )}

      {basketActive && base?.kind === "basket_draft" && (
        <BasketView
          payload={base}
          legs={basketLegs}
          preview={basketPreview}
          result={basketResult}
          verifications={basketVerifications}
          canReview={writeEnabled && Boolean(credentials[base.environment])}
          busy={loading}
          book={book}
          locale={locale}
          t={t}
          onRemoveLeg={(index) => { if (!basketPreview && !basketResult) setBasketLegs((current) => current.filter((_, i) => i !== index)); }}
          onReview={() => void reviewBasket()}
          onBack={() => setBasketPreview(null)}
          onConfirm={(liveAcknowledged) => void confirmBasket(liveAcknowledged)}
          onClose={() => void closeBasket()}
          onVerify={(id) => void verifyBasketLeg(id)}
        />
      )}

      {basketActive && base?.kind === "pie_change_draft" && (
        <PieChangeView
          payload={base}
          preview={piePreview}
          result={pieResult}
          canReview={writeEnabled && Boolean(credentials[base.draft.environment])}
          busy={loading}
          book={book}
          locale={locale}
          t={t}
          onReview={() => void reviewPieChange()}
          onBack={() => setPiePreview(null)}
          onConfirm={(liveAcknowledged) => void confirmPieChange(liveAcknowledged)}
          onClose={() => void closePieChange()}
        />
      )}

      {draft && !preview && !cancelPreview && (
        <OrderEditor
          draft={draft}
          originalDraft={base?.kind === "order_draft" ? base.draft : undefined}
          resolution={base?.kind === "order_draft" ? base.resolution : undefined}
          resolvedInstrument={base?.kind === "order_draft" ? base.resolvedInstrument : undefined}
          book={book}
          locale={locale}
          t={t}
          busy={loading}
          onChange={setDraft}
          onClose={() => void closeOrderDraft()}
          onReview={() => void reviewOrder()}
        />
      )}

      {preview && !cancelPreview && (
        <OrderConfirmation
          preview={preview}
          book={book}
          locale={locale}
          t={t}
          busy={loading}
          onBack={() => setPreview(null)}
          onConfirm={(liveAcknowledged) => void confirmOrder(liveAcknowledged)}
        />
      )}

      {cancelTarget && (
        <ConfirmModal
          key={`cancel-${cancelTarget.orderId}`}
          title={cancelTarget.environment === "live" ? t("confirmCancelTitleLive") : t("confirmCancelTitleDemo")}
          body={cancelTarget.order?.ticker || cancelPreview
            ? <p>{cancelDescription(cancelTarget, t, locale, positions, book)}</p>
            : <p>{fill(t("cancelOrderGone"), { id: cancelTarget.orderId })}</p>}
          danger={cancelTarget.environment === "live"}
          confirmLabel={t("confirmCancel")}
          busy={loading}
          t={t}
          canConfirm={Boolean(cancelPreview || (base?.kind === "cancel_draft" && base.order)) && writeEnabled}
          ready={Boolean(cancelPreview)}
          {...(cancelTarget.environment === "live" ? { acknowledgement: t("liveCancelAckLabel") } : {})}
          onCancel={() => void closeCancel()}
          onConfirm={(acknowledged) => void confirmCancel(acknowledged)}
        />
      )}
    </div>
  );
}
