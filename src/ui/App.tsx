import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
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
import { APP_META } from "../shared/meta";
import { createTranslator, resolveLocale, type SupportedLocale } from "./i18n";
import { Icon } from "./components/common";
import { formatProblem, verificationText } from "./lib/messages";
import { ConfirmModal, OrderConfirmation, OrderEditor } from "./views/OrderViews";
import { PortfolioView } from "./views/PortfolioView";
import { AllocationView, IncomeView, PerformanceView, type InsightPeriod } from "./views/InsightsView";
import type { AllocationAnalysis, IncomeSummary, PerformanceSummary } from "../shared/history";
import { TradePlanView } from "./views/TradePlanView";
import { BasketView, type BasketDraftView } from "./views/BasketView";
import { PieChangeView, PiesView } from "./views/PiesView";
import { AutomationView } from "./views/AutomationView";
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
  | ErrorPayload;

type WithAccess<T> = T & { credentials: CredentialStatus; writeEnabled?: boolean };
type InsightPayload = WithAccess<AllocationAnalysis> | WithAccess<PerformanceSummary> | WithAccess<IncomeSummary>;
type InsightKind = InsightPayload["kind"];
type PortfolioTab = "holdings" | InsightKind;
type InsightCache = { allocation?: WithAccess<AllocationAnalysis>; performance?: WithAccess<PerformanceSummary>; income?: WithAccess<IncomeSummary> };

const INSIGHT_TOOLS: Record<InsightKind, string> = {
  allocation: "analyze_portfolio_allocation",
  performance: "get_portfolio_performance",
  income: "get_income_summary",
};
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
  if (!payload || payload.kind === "error") return "demo";
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

export default function App() {
  const [base, setBase] = useState<BasePayload | null>(null);
  const [tab, setTab] = useState<PortfolioTab>("holdings");
  const [insights, setInsights] = useState<InsightCache>({});
  const [period, setPeriod] = useState<InsightPeriod>("ytd");
  const [environment, setEnvironment] = useState<TradingEnvironment>("demo");
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [execution, setExecution] = useState<OrderExecutionResult | null>(null);
  const [verification, setVerification] = useState<ExecutionVerificationResult | null>(null);
  const [basketLegs, setBasketLegs] = useState<BasketLeg[]>([]);
  const [basketPreview, setBasketPreview] = useState<BasketPreview | null>(null);
  const [basketResult, setBasketResult] = useState<BasketExecutionResult | null>(null);
  const [basketVerifications, setBasketVerifications] = useState<Record<string, ExecutionVerificationResult>>({});
  const [piePreview, setPiePreview] = useState<PieChangePreview | null>(null);
  const [pieResult, setPieResult] = useState<PieChangeResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    readSavedLocale() ?? resolveLocale(typeof navigator === "undefined" ? "en" : navigator.language),
  );
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [availableDisplayModes, setAvailableDisplayModes] = useState<DisplayMode[]>(["inline"]);
  const transactionExpansionAttempted = useRef(false);

  const t = useMemo(() => createTranslator(locale), [locale]);

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
        if (!payload) return;
        setBase(payload);
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
      };
    },
  });

  useHostStyles(app, app?.getHostContext());
  // The host's initial context (locale, display modes) is only available after connecting.
  useEffect(() => {
    if (app) syncHostContext(app.getHostContext());
  }, [app]);

  const transactionActive = Boolean(draft || preview || cancelPreview);
  const basketActive = (base?.kind === "basket_draft" || base?.kind === "pie_change_draft") && !transactionActive;

  useEffect(() => {
    if (!transactionActive && !basketActive) {
      transactionExpansionAttempted.current = false;
      return;
    }
    if (transactionExpansionAttempted.current || !app || displayMode === "fullscreen") return;
    if (!availableDisplayModes.includes("fullscreen")) return;
    if (typeof window === "undefined" || window.innerHeight >= 560) return;

    transactionExpansionAttempted.current = true;
    void app.requestDisplayMode({ mode: "fullscreen" })
      .then((result) => setDisplayMode(result.mode))
      .catch(() => {
        // The in-flow transaction layout is the fallback when the host declines fullscreen.
      });
  }, [app, availableDisplayModes, basketActive, displayMode, transactionActive]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (error) setErrorMessage(error.message);
  }, [error]);

  const credentials: CredentialStatus = useMemo(() => {
    if (!base || base.kind === "error") return { demo: false, live: false };
    return base.credentials;
  }, [base]);

  const writeEnabled = base && base.kind !== "error" ? base.writeEnabled !== false : false;

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
    return result.structuredContent as unknown as T;
  }

  function caughtMessage(value: unknown): string {
    return value instanceof ToolCallError ? formatProblem(value.problem, t, locale) : value instanceof Error ? value.message : String(value);
  }

  async function loadInsight(kind: InsightKind, env = environment, range = period): Promise<void> {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const args = kind === "allocation" ? { environment: env } : { environment: env, period: range };
      const payload = await callTool<InsightPayload>(INSIGHT_TOOLS[kind], args);
      setInsights((current) => ({ ...current, [kind]: payload }));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
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
    if (target !== "holdings" && base?.kind !== "trade_plan") return loadInsight(target, env);
    setStatus("loading");
    setErrorMessage(null);
    try {
      if (base?.kind === "automation") {
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
      }
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
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
      setErrorMessage(caughtMessage(requestError));
    }
  }

  async function closeOrderDraft(): Promise<void> {
    setDraft(null);
    setPreview(null);
    if (base?.kind === "order_draft") await refresh(environment);
  }

  async function reviewOrder(): Promise<void> {
    if (!draft) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      setPreview(await callTool<OrderPreview>("app_prepare_order", draft as unknown as Record<string, unknown>));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function confirmOrder(liveAcknowledged = false): Promise<void> {
    if (!preview) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const confirmationCode = preview["token"];
      const result = await callTool<OrderExecutionResult>("app_execute_order", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) });
      setExecution(result);
      setVerification(null);
      setPreview(null);
      setDraft(null);
      await refresh(environment);
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  function resetBasket(): void {
    setBasketLegs([]);
    setBasketPreview(null);
    setBasketResult(null);
    setBasketVerifications({});
  }

  async function closeBasket(): Promise<void> {
    resetBasket();
    setErrorMessage(null);
    await refresh(environment, "holdings");
  }

  async function reviewBasket(): Promise<void> {
    if (base?.kind !== "basket_draft" || basketLegs.length === 0) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      setBasketPreview(await callTool<BasketPreview>("app_prepare_basket", {
        environment: base.environment,
        purpose: base.purpose,
        title: base.title,
        drafts: basketLegs.map((leg) => ({ ...leg.draft, environment: base.environment })),
        ...(base.planId ? { planId: base.planId } : {}),
        ...(base.notes?.length ? { notes: base.notes } : {}),
      }));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function confirmBasket(liveAcknowledged = false): Promise<void> {
    if (!basketPreview) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const confirmationCode = basketPreview["token"];
      const result = await callTool<BasketExecutionResult>("app_execute_basket", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) });
      setBasketResult(result);
      setBasketVerifications({});
    } catch (requestError) {
      // The token may already be consumed; never resend it. The person must review again explicitly.
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setBasketPreview(null);
      setStatus("idle");
    }
  }

  async function closePieChange(): Promise<void> {
    setPiePreview(null);
    setPieResult(null);
    setErrorMessage(null);
    await refresh(environment, "holdings");
  }

  async function reviewPieChange(): Promise<void> {
    if (base?.kind !== "pie_change_draft") return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      setPiePreview(await callTool<PieChangePreview>("app_prepare_pie_change", base.draft as unknown as Record<string, unknown>));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function confirmPieChange(liveAcknowledged = false): Promise<void> {
    if (!piePreview) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const confirmationCode = piePreview["token"];
      setPieResult(await callTool<PieChangeResult>("app_execute_pie_change", { ["token"]: confirmationCode, ...(liveAcknowledged ? { liveAcknowledged: true } : {}) }));
    } catch (requestError) {
      // The token may already be consumed; never resend it.
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setPiePreview(null);
      setStatus("idle");
    }
  }

  async function verifyBasketLeg(verificationId: string): Promise<void> {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const result = await callTool<ExecutionVerificationResult>("app_verify_unknown_execution", { verificationId });
      setBasketVerifications((current) => ({ ...current, [verificationId]: result }));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function startCancel(orderId: string): Promise<void> {
    setStatus("loading");
    setErrorMessage(null);
    try {
      setCancelPreview(await callTool<CancelPreview>("app_prepare_cancel", { environment, orderId }));
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function confirmCancel(): Promise<void> {
    if (!cancelPreview) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const confirmationCode = cancelPreview["token"];
      const result = await callTool<OrderExecutionResult>("app_execute_cancel", { ["token"]: confirmationCode });
      setExecution(result);
      setVerification(null);
      setCancelPreview(null);
      await refresh(environment);
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function verifyUnknownExecution(): Promise<void> {
    if (!execution?.verificationId) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const result = await callTool<ExecutionVerificationResult>("app_verify_unknown_execution", { verificationId: execution.verificationId });
      setVerification(result);
      await refresh(environment);
    } catch (requestError) {
      setErrorMessage(caughtMessage(requestError));
    } finally {
      setStatus("idle");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cancelPreview) setCancelPreview(null);
      else if (preview) setPreview(null);
      else if (basketPreview && status !== "loading") setBasketPreview(null);
      else if (piePreview && status !== "loading") setPiePreview(null);
      else if (draft) { setDraft(null); setPreview(null); if (base?.kind === "order_draft") void refresh(environment); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [base, basketPreview, cancelPreview, draft, environment, piePreview, preview, status]);

  if (!app && !error) {
    return <div className="centerState"><div className="spinner" />{t("connecting")}</div>;
  }

  const canToggleFullscreen = availableDisplayModes.includes("fullscreen") || displayMode === "fullscreen";

  return (
    <div className={`appShell mode-${displayMode}`}>
      <header className="appHeader">
        <div className="brandBlock">
          <div className="brandMark">TP</div>
          <div className="brandCopy">
            <span className="brokerLabel">{t("brokerName")}</span>
            <h1>{t("appName")}</h1>
          </div>
        </div>

        <div className="headerActions">
          <div className="environmentSwitch" aria-label={t("environment")}>
            <button
              type="button"
              className={environment === "demo" ? "active" : ""}
              onClick={() => void switchEnvironment("demo")}
              disabled={status === "loading" || basketActive}
            >
              <span className={`statusDot ${credentials.demo ? "ready" : ""}`} />
              {t("demo")}
            </button>
            <button
              type="button"
              className={environment === "live" ? "active live" : "live"}
              onClick={() => void switchEnvironment("live")}
              disabled={status === "loading" || basketActive}
            >
              <span className={`statusDot ${credentials.live ? "ready" : ""}`} />
              {t("live")}
            </button>
          </div>

          <div className="languageControl" title={t("language")}>
            <Icon name="globe" />
            <button className={locale === "zh-CN" ? "active" : ""} onClick={() => changeLocale("zh-CN")}>中文</button>
            <span>/</span>
            <button className={locale === "en" ? "active" : ""} onClick={() => changeLocale("en")}>EN</button>
          </div>

          {canToggleFullscreen && (
            <button className="iconAction" type="button" onClick={() => void toggleDisplayMode()} title={displayMode === "fullscreen" ? t("collapse") : t("expand")}>
              <Icon name={displayMode === "fullscreen" ? "collapse" : "expand"} />
              <span className="actionText">{displayMode === "fullscreen" ? t("collapse") : t("expand")}</span>
            </button>
          )}
          <button className="iconAction" type="button" onClick={() => void refresh()} disabled={status === "loading" || basketActive} title={t("refresh")}>
            <Icon name="refresh" />
            <span className="actionText">{status === "loading" ? t("refreshing") : t("refresh")}</span>
          </button>
        </div>
      </header>

      <div className={`environmentBar ${environment}`}>
        <div>
          <strong>{environment === "live" ? t("liveMoney") : credentials.sample ? t("sampleAccount") : t("demoAccount")}</strong>
          <span>{environment === "live" ? t("liveDescription") : credentials.sample ? t("sampleDescription") : t("demoDescription")}</span>
        </div>
        <span className="connectionBadge"><span className="statusDot ready" />{t("connected")}</span>
      </div>

      {!writeEnabled && base && base.kind !== "error" && (
        <div className="notice warning"><strong>{t("readonlyMode")}</strong><span>{t("readonlyHint")}</span></div>
      )}
      {errorMessage && <div className="notice error" role="alert"><strong>{t("syncError")}</strong><span>{errorMessage}</span></div>}
      {execution && (
        <div className={`notice executionNotice ${execution.ok ? "success" : execution.status === "unknown" ? "warning" : "error"}`} role="status" aria-live="polite">
          <div className="noticeCopy">
            <strong>{execution.status === "unknown" ? t("unknownStatus") : execution.ok ? t("submitted") : t("notSubmitted")}</strong>
            <span>{execution.error ? formatProblem(execution.error, t, locale) : execution.message}</span>
            {verification && <span className="verificationResult">{verificationText(verification, t)}</span>}
          </div>
          {execution.status === "unknown" && execution.verificationId && (
            <button className="secondaryButton" type="button" disabled={status === "loading"} onClick={() => void verifyUnknownExecution()}>
              {status === "loading" ? t("verifying") : t("verifyExecution")}
            </button>
          )}
        </div>
      )}

      {!transactionActive && (
        <>
        {base?.kind === "error" && <div className="emptyState">{formatProblem(base.error, t, locale)}</div>}
        {(base?.kind === "portfolio" || isInsight(base)) && (
          <nav className="viewTabs" aria-label={t("viewsLabel")}>
            {(["holdings", "allocation", "performance", "income"] as const).map((key) => (
              <button key={key} type="button" aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : ""} disabled={status === "loading"} onClick={() => void selectTab(key)}>
                {t(key === "holdings" ? "tabHoldings" : key === "allocation" ? "tabAllocation" : key === "performance" ? "tabPerformance" : "tabIncome")}
              </button>
            ))}
          </nav>
        )}
        {base?.kind === "portfolio" && tab === "holdings" && (
          <PortfolioView payload={base} locale={locale} t={t} writeEnabled={writeEnabled} onCancel={(id) => void startCancel(id)} />
        )}
        {tab !== "holdings" && (base?.kind === "portfolio" || isInsight(base)) && !insights[tab] && (
          <div className="emptyState">{status === "loading" ? t("loadingInsights") : t("noData")}</div>
        )}
        {tab === "allocation" && insights.allocation && <AllocationView data={insights.allocation} locale={locale} t={t} />}
        {tab === "performance" && insights.performance && (
          <PerformanceView data={insights.performance} locale={locale} t={t} period={period} busy={status === "loading"} onPeriod={(next) => void changePeriod(next)} />
        )}
        {tab === "income" && insights.income && (
          <IncomeView data={insights.income} locale={locale} t={t} period={period} busy={status === "loading"} onPeriod={(next) => void changePeriod(next)} />
        )}
        {base?.kind === "trade_plan" && (
          <TradePlanView
            payload={base}
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
        {base?.kind === "pies" && <PiesView payload={base} locale={locale} t={t} />}
        {base?.kind === "automation" && <AutomationView data={base} locale={locale} t={t} />}
        {base?.kind === "order_draft" && !draft && <div className="emptyState">{t("orderLoaded")}</div>}
        {!base && <div className="emptyState">{t("waiting")}</div>}


        </>
      )}

      {basketActive && base?.kind === "basket_draft" && (
        <BasketView
          payload={base}
          legs={basketLegs}
          preview={basketPreview}
          result={basketResult}
          verifications={basketVerifications}
          canReview={writeEnabled && Boolean(credentials[base.environment])}
          busy={status === "loading"}
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
          busy={status === "loading"}
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
          locale={locale}
          t={t}
          busy={status === "loading"}
          onChange={setDraft}
          onClose={() => void closeOrderDraft()}
          onReview={() => void reviewOrder()}
        />
      )}

      {preview && !cancelPreview && (
        <OrderConfirmation
          preview={preview}
          locale={locale}
          t={t}
          busy={status === "loading"}
          onBack={() => setPreview(null)}
          onConfirm={(liveAcknowledged) => void confirmOrder(liveAcknowledged)}
        />
      )}

      {cancelPreview && (
        <ConfirmModal
          title={cancelPreview.environment === "live" ? t("confirmCancelTitleLive") : t("confirmCancelTitleDemo")}
          body={`${t("order")} ${cancelPreview.orderId}`}
          danger={cancelPreview.environment === "live"}
          confirmLabel={t("confirmCancel")}
          busy={status === "loading"}
          t={t}
          onCancel={() => setCancelPreview(null)}
          onConfirm={() => void confirmCancel()}
        />
      )}
    </div>
  );
}
