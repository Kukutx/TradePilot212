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
  OrderStatusReport,
  Preferences,
  StructuredError,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts";
import type { AutomationOverview, BasketExecutionResult, BasketLeg, BasketPreview } from "../shared/automation";
import type { HoldingDetail } from "../shared/holding";
import { journalText, type JournalReview } from "../shared/journal";
import { APP_META } from "../shared/meta";
import { createTranslator, resolveLocale, type MessageKey, type SupportedLocale } from "./i18n";
import { ErrorCard, Icon, SkeletonView } from "./components/common";
import { TipLayer } from "./components/tips";
import { bookFromPayload, mergeBooks, readSavedBook, saveBook, type InstrumentBook } from "./lib/instruments";
import { envLabel, executionText, fill, formatProblem, verificationText, type ExecutionKind } from "./lib/messages";
import { cancelDescription, ConfirmModal, OrderConfirmation, OrderEditor } from "./views/OrderViews";
import { intentForAccount } from "./lib/orders";
import { PortfolioView, type TodayState } from "./views/PortfolioView";
import type { PortfolioToday } from "../shared/today";
import { AllocationView, IncomeView, PerformanceView, periodOf, type InsightPeriod } from "./views/InsightsView";
import type { EqualRiskPlan } from "./components/holding-parity";
import { covarianceFits, type MeasuredRisk, type TargetSave } from "./components/target-editor";
import type { AllocationAnalysis, CashHistory, HistoryFilter, HoldingCovariancePayload, IncomeSummary, PerformanceSummary, TaxYearSummary, TradeHistory } from "../shared/history";
import type { JournalEntry } from "../shared/journal";
import { CashHistoryView, HISTORY_KINDS, TAX_RULES, TaxYearView, TradeHistoryView, type HistoryKind } from "./views/HistoryView";
import { TradePlanView } from "./views/TradePlanView";
import { BasketView, type BasketDraftView } from "./views/BasketView";
import { PieChangeView, PiesView } from "./views/PiesView";
import type { PlanRequest, PlanSaveResult } from "./components/plans";
import { AutomationView, type NotifyTestResult } from "./views/AutomationView";
import { HoldingView } from "./views/HoldingView";
import { JournalReviewView } from "./views/JournalView";
import { WatchlistView } from "./views/WatchlistView";
import { ExportView, OrderStatusView, type ExportPayload } from "./views/ToolViews";
import type { WatchlistView as WatchlistPayload } from "../shared/watchlist";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PiesPayload } from "../shared/pies";
import { taxYearZone } from "../shared/time-zone";
import { RangeContext, type DateRange } from "./components/range-picker";

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
  | PieChangeDraftPayload
  | CancelDraftPayload
  | HoldingDetail
  | WithAccess<OrderStatusReport>
  | WithAccess<ExportPayload>
  | ErrorPayload;

type WithAccess<T> = T & { credentials: CredentialStatus; writeEnabled?: boolean };
type InsightPayload = WithAccess<AllocationAnalysis> | WithAccess<PerformanceSummary> | WithAccess<IncomeSummary> | WithAccess<JournalReview> | WithAccess<WatchlistPayload>
  | WithAccess<TradeHistory & { journal?: JournalEntry[] }> | WithAccess<CashHistory> | WithAccess<TaxYearSummary> | PiesPayload | AutomationOverview;
type InsightKind = InsightPayload["kind"];
type PortfolioTab = "holdings" | InsightKind;
type InsightCache = { [K in InsightKind]?: Extract<InsightPayload, { kind: K }> };
/**
 * The tax year the History tab shows: the latest that has started unless a year was picked, starting on `yearStart`
 * (month-day; the server's TAX_YEAR_START when left out) in `timeZone` (the server's TIMEZONE, else the viewer's own,
 * when left out).
 */
interface TaxSettings { year?: number; yearStart?: string; timeZone?: string }
/**
 * What the host limited a trade or cash read to, kept while the page is read again: an instrument or types, and a window
 * none of the switch's periods is. Choosing a period drops the window; Show all drops both.
 */
type ScopedKind = "trade_history" | "cash_history";
type HistoryScopes = Partial<Record<ScopedKind, { filter?: HistoryFilter; window?: { from?: string; to: string } }>>;

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
  journal_review: "get_journal_review",
  watchlist: "get_watchlist",
  trade_history: "get_trade_history",
  cash_history: "get_cash_history",
  tax_year: "get_tax_year_summary",
  pies: "app_list_pies",
  automation: "app_get_automation",
};
const TAB_KEYS: Record<PortfolioTab, MessageKey> = {
  holdings: "tabHoldings", watchlist: "tabWatchlist", allocation: "tabAllocation", performance: "tabPerformance", income: "tabIncome", journal_review: "tabJournal",
  trade_history: "tabHistory", cash_history: "tabHistory", tax_year: "tabHistory", pies: "piesTitle", automation: "automationTitle",
};
/** The tab strip, in order; "history" stands for whichever of its three pages was shown last. */
const TABS = ["holdings", "watchlist", "allocation", "performance", "income", "history", "journal_review", "pies", "automation"] as const;
/**
 * Tool results shown on a page the widget already has, read for that page: the automation page for alerts, plans and
 * the trading rules, the allocation for targets, and the account, with its activity, for recent activity.
 */
const ROUTES = { price_alerts: "automation", investment_plans: "automation", trading_policy: "automation", target_allocation: "allocation", activity: "holdings" } as const;
type RoutedPayload = {
  kind: keyof typeof ROUTES; environment?: TradingEnvironment; defaultEnvironment?: TradingEnvironment; timestamp?: string; targets?: unknown;
  alerts?: Array<{ environment?: TradingEnvironment }>; plans?: Array<{ environment?: TradingEnvironment }>;
};
const isRouted = (payload: { kind?: unknown }): payload is RoutedPayload => typeof payload.kind === "string" && Object.hasOwn(ROUTES, payload.kind);
/** The account a routed result is about: the one it names, else (a list of both accounts) the server's default. */
const routeEnvironment = (payload: RoutedPayload): TradingEnvironment => payload.environment ?? payload.defaultEnvironment ?? payload.alerts?.[0]?.environment ?? payload.plans?.[0]?.environment ?? "demo";
/**
 * A routed result read this long ago is a saved one shown again (an old chat): its page is read only when asked, so
 * reopening a chat with many of them does not read the account for each at once.
 */
const ROUTE_FRESH_MS = 2 * 60_000;
const routeFresh = (payload: RoutedPayload) => !!payload.timestamp && Date.now() - Date.parse(payload.timestamp) <= ROUTE_FRESH_MS;
/** Tabs read for the account as it is now, with no period (the tax year has its own year). */
const timeless = (kind: InsightKind) => kind === "allocation" || kind === "watchlist" || kind === "tax_year" || kind === "pies" || kind === "automation";
const isHistory = (kind: PortfolioTab): kind is HistoryKind => (HISTORY_KINDS as readonly string[]).includes(kind);
const INSIGHT_KINDS: ReadonlySet<string> = new Set(Object.keys(INSIGHT_TOOLS));

const isInsight = (payload: BasePayload | null): payload is InsightPayload => !!payload && INSIGHT_KINDS.has(payload.kind);
/** The window a tab with a period was read for. */
/** What a read was for: the range chosen (its exact bounds when the host gave them), or the period. */
const readKey = (custom: DateRange | null, period: InsightPeriod) => (custom ? `range:${custom.exact?.from ?? custom.from}..${custom.exact?.to ?? custom.to}` : `period:${period}`);
const periodOfPayload = (payload: InsightPayload): { from?: string; to: string } | undefined => ("period" in payload && !timeless(payload.kind) ? payload.period : undefined);
/** How long after a read its window may end and still be "up to now", as the switch's periods are. */
const NOW_SLACK_MS = 10 * 60_000;
/** The switch's period a read was for, or none when the host read another window (its own dates, or a week). */
function presetOf(range: { from?: string; to: string }, readAt: string): InsightPeriod | undefined {
  if (!(Math.abs(Date.parse(range.to) - Date.parse(readAt)) <= NOW_SLACK_MS)) return undefined;
  if (!range.from) return "all";
  const period = periodOf(range);
  // periodOf names any bounded window it does not know 12 months.
  return period === "1y" && Math.abs((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 - 365) >= 1 ? undefined : period;
}
/**
 * The zone a tax year is counted in when none was chosen: the server's TIMEZONE, else the zone its first day is known
 * by (London's for 6 April), else the viewer's own.
 */
function taxZone(yearStart: string | undefined, preferences: Preferences | undefined): string {
  return preferences?.timeZone ?? taxYearZone(yearStart) ?? localZone();
}
/** The viewer's own zone. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type Status = "idle" | "loading";
type DisplayMode = "inline" | "fullscreen" | "pip";
const LOCALE_STORAGE_KEY = "tradepilot212.locale";
/** How old a dashboard can be for the day's moves to be read for it: an older one is a saved result shown again. */
const TODAY_FRESH_MS = 2 * 60_000;
/** The holdings' covariance is read again after this long: the weekly closes it comes from change once a week. */
const COVARIANCE_KEEP_MS = 30 * 60_000;
/** Why a covariance read can leave out an instrument not held this time but not the next: read again rather than kept. */
const PASSING_MISSES = new Set(["later", "data"]);

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

/** A send refused before anything reached Trading 212 because a risk-sized buy needs a new review. */
const RISK_RECHECK: ReadonlySet<string> = new Set(["RISK_CHANGED", "RISK_CHECK_UNAVAILABLE"]);

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
    // The plan's reasoning starts the journal note; the editor can change or clear it.
    ...(journalText(candidate.thesis ?? candidate.rationale) ? { thesis: journalText(candidate.thesis ?? candidate.rationale)! } : {}),
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
function ViewTabs({ tab, history, busy, t, onSelect }: { tab: PortfolioTab; history: HistoryKind; busy: boolean; t: (key: MessageKey) => string; onSelect: (next: PortfolioTab) => void }) {
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
      {/* A tab reached with the keyboard scrolls into view, ring and all. */}
      <nav className="viewTabs" aria-label={t("viewsLabel")} ref={nav} onFocus={(event) => event.target.scrollIntoView?.({ inline: "nearest", block: "nearest" })}>
        {TABS.map((key) => {
          const target: PortfolioTab = key === "history" ? history : key;
          const active = key === "history" ? isHistory(tab) : tab === key;
          return (
            <button key={key} type="button" aria-current={active ? "page" : undefined} className={active ? "active" : ""} aria-disabled={busy && !active ? true : undefined} onClick={() => { if (!busy && !active) onSelect(target); }}>
              {t(TAB_KEYS[target])}
            </button>
          );
        })}
      </nav>
      {/* For a mouse, which cannot swipe: a press on a faded edge scrolls the tabs along. A finger swipes and the
          keyboard moves through the tabs, so these are neither announced nor a Tab stop. */}
      {(["start", "end"] as const).filter((edge) => edges[edge]).map((edge) => (
        <button key={edge} type="button" className={`tabScroll ${edge}`} tabIndex={-1} aria-hidden="true" onMouseDown={(event) => event.preventDefault()}
          onClick={() => nav.current?.scrollBy({ left: (edge === "end" ? 1 : -1) * nav.current.clientWidth * 0.7, behavior: "smooth" })}>
          <Icon name="arrow" />
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [base, setBase] = useState<BasePayload | null>(null);
  /** A result to show on another page, held until the connection can read that page. */
  const [route, setRoute] = useState<RoutedPayload | null>(null);
  /** A saved routed result, whose page opens when asked. */
  const [laterRoute, setLaterRoute] = useState<RoutedPayload | null>(null);
  // The dashboard a holding was opened from, so Back returns to it without a new read.
  const [holdingFrom, setHoldingFrom] = useState<DashboardPayload | null>(null);
  // The view a holding was opened from, such as the journal, and its account, so Back returns to it.
  const [holdingReturn, setHoldingReturn] = useState<{ tab: PortfolioTab; environment: TradingEnvironment } | null>(null);
  // The tag the journal tab shows, kept when its period changes or a note is saved; none shows every trade.
  const [journalTag, setJournalTag] = useState<string | undefined>(undefined);
  /** The fund the performance tab compares with, once picked; the server's default until then. */
  const [benchmark, setBenchmark] = useState<string | undefined>(undefined);
  /** The day's moves of the dashboard on screen, read after it: keyed by its account and when it was read. */
  const [today, setToday] = useState<TodayState & { key: string } | null>(null);
  const [tab, setTab] = useState<PortfolioTab>("holdings");
  const [insights, setInsights] = useState<InsightCache>({});
  const [insightError, setInsightError] = useState<{ kind: InsightKind; problem: Problem } | null>(null);
  const [period, setPeriod] = useState<InsightPeriod>("ytd");
  /** Days the reader chose instead of a period, for every view with the period switch until a period is chosen. */
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  /** What each tab's data was read for (a period, a range, or the host's own window), to tell when it is stale. */
  const readFor = useRef<Partial<Record<InsightKind, string>>>({});
  /** The History tab's page shown last, and the tax year it shows. */
  const [historyKind, setHistoryKind] = useState<HistoryKind>("trade_history");
  const [taxSettings, setTaxSettings] = useState<TaxSettings>({});
  // The server's TIMEZONE and TAX_YEAR_START, from the dashboard: the tax year's defaults.
  const [preferences, setPreferences] = useState<Preferences | undefined>(undefined);
  useEffect(() => {
    if (base?.kind === "portfolio" && base.preferences) setPreferences(base.preferences);
    else if (base?.kind === "automation" && base.settings.taxYearStart) setPreferences({ ...(base.settings.timeZone ? { timeZone: base.settings.timeZone } : {}), taxYearStart: base.settings.taxYearStart });
  }, [base]);
  const [historyScopes, setHistoryScopes] = useState<HistoryScopes>({});
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
  const covariances = useRef(new Map<string, { at: number; read: Promise<HoldingCovariancePayload> }>());

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
        const payload = toolResult.structuredContent as unknown as BasePayload | RoutedPayload | undefined;
        if (!payload) return;
        if (isRouted(payload)) setRoute(payload);
        else showPayload(payload);
      };
    },
  });

  /** Show a tool result as the widget's main view, as when the host hands one over. Uses only state setters and refs. */
  function showPayload(payload: BasePayload): void {
    learn(payload);
    setBase(payload);
    // A page the host hands over starts fresh: Back from a holding then reads the dashboard again.
    setHoldingFrom(null);
    setHoldingReturn(null);
    setProblem(null);
    setInsightError(null);
    // What an earlier trade or cash read was limited to does not carry over to another page the host shows.
    setHistoryScopes({});
    const env = initialEnvironment(payload);
    setEnvironment(env);
    if (isInsight(payload)) {
      if (payload.kind === "journal_review") setJournalTag(payload.tag);
      // The fund the host's read compared with stays for the next period or refresh.
      if (payload.kind === "performance" && payload.benchmarkChoice) setBenchmark(payload.benchmarkChoice);
      setInsights({ [payload.kind]: payload });
      setTab(payload.kind);
      if (isHistory(payload.kind)) setHistoryKind(payload.kind);
      if (payload.kind === "tax_year") setTaxSettings({ year: payload.year, yearStart: payload.yearStart, timeZone: payload.timeZone });
      const range = periodOfPayload(payload);
      const preset = range && presetOf(range, payload.timestamp);
      if (preset) setPeriod(preset);
      // Another window the host read shows as a range on the switch's button; a trade or cash page shows its own.
      // Its own bounds are kept for reading it again: only the days the reader chooses are whole days.
      const hostRange = range && !preset && range.from && payload.kind !== "trade_history" && payload.kind !== "cash_history"
        ? { from: range.from.slice(0, 10), to: range.to.slice(0, 10), exact: { from: range.from, to: range.to } } : null;
      setCustomRange(hostRange);
      readFor.current = { [payload.kind]: preset ? readKey(null, preset) : hostRange ? readKey(hostRange, preset ?? "all") : "host" };
      if (payload.kind === "trade_history" || payload.kind === "cash_history") {
        setHistoryScopes({ [payload.kind]: { ...(payload.filter ? { filter: payload.filter } : {}), ...(range && !preset ? { window: range } : {}) } });
      }
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

  // Each dashboard read is followed by the day's moves of its holdings (previous closes come from the quote provider,
  // so they are read on their own and never hold up the dashboard). A dashboard that carries them uses those.
  useEffect(() => {
    if (base?.kind !== "portfolio" || !base.credentials[base.environment] || !base.positions.length) return;
    const key = `${base.environment}:${base.timestamp}`;
    if (base.today) {
      setToday({ key, data: base.today, loading: false });
      return;
    }
    if (!app || today?.key === key) return;
    // A dashboard shown again long after it was read (the host's saved result) is not set against today's closes.
    if (Date.now() - Date.parse(base.timestamp) > TODAY_FRESH_MS) return;
    setToday({ key, loading: true });
    const settle = (data?: PortfolioToday) => setToday((current) => (current?.key === key ? { key, ...(data ? { data } : { failed: true }), loading: false } : current));
    callTool<PortfolioToday>("app_get_today", { environment: base.environment }).then(settle, () => settle());
    // Only a new dashboard (or the connection) starts a read; the day's state itself does not.
  }, [app, base]);

  useEffect(() => {
    if (!app || !route) return;
    setRoute(null);
    if (routeFresh(route)) void openRoute(route);
    else {
      setEnvironment(routeEnvironment(route));
      setLaterRoute(route);
    }
    // Each result is opened once, when it and the connection are both there.
  }, [app, route]);

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

  /**
   * Plan a rebalance from the saved targets, with a band of only the ones further off than it; the trades open as a
   * basket to review, nothing is sent.
   */
  async function rebalanceToTargets(env: TradingEnvironment, buyOnly = false, band?: number): Promise<void> {
    await run("errorTitleRebalance", async () => {
      showPayload(await callTool<BasePayload>("plan_portfolio_rebalance", { environment: env, ...(buyOnly ? { buyOnly } : {}), ...(band === undefined ? {} : { band }) }));
    }, () => void rebalanceToTargets(env, buyOnly, band));
  }

  /** Plan the move to the equal-risk weights; the trades open as a basket to review, nothing is sent. */
  async function rebalanceToEqualRisk(plan: EqualRiskPlan, env: TradingEnvironment): Promise<void> {
    await run("errorTitleRebalance", async () => {
      showPayload(await callTool<BasePayload>("plan_portfolio_rebalance", { environment: env, targets: plan.targets, cashWeight: plan.cashWeight }));
    }, () => void rebalanceToEqualRisk(plan, env));
  }

  /**
   * The holdings' covariance, for the risk at the targets typed in: read for the holdings the risk on screen measured,
   * with the instruments not held in the form beside them, and kept a while for them and its weeks, as the closes it
   * is read from change once a week. A failed read, one that does not fit the risk on screen, and one that left out an
   * instrument not held for a reason that can pass (its closes on their way, or not read this time), are not kept: a
   * Refresh reads them again. One left out for good (no symbol, too few weeks) is kept like the rest.
   */
  function readCovariance(env: TradingEnvironment, measured: MeasuredRisk, alongside: string[]): Promise<HoldingCovariancePayload> {
    const tickers = measured.rows.map((row) => row.ticker);
    const key = `${env}:${measured.to}:${measured.weeks}:${[...tickers].sort().join(",")}:${[...alongside].sort().join(",")}`;
    const kept = covariances.current.get(key);
    if (kept && Date.now() - kept.at < COVARIANCE_KEEP_MS) return kept.read;
    const read = callTool<HoldingCovariancePayload>("app_get_holding_covariance", { environment: env, tickers, ...(alongside.length ? { alongside } : {}) });
    covariances.current.set(key, { at: Date.now(), read });
    const forget = () => { if (covariances.current.get(key)?.read === read) covariances.current.delete(key); };
    read.then((payload) => {
      if (!covarianceFits(payload, measured, alongside) || payload.covariance?.unmeasured?.some((item) => PASSING_MISSES.has(item.reason))) forget();
    }, forget);
    return read;
  }

  /** Save or remove the target weights, then read the allocation again so it shows their drift. Targets never trade. */
  async function changeTargets(input: Record<string, unknown>, env: TradingEnvironment): Promise<boolean> {
    const done = await run("errorTitleTargets", async () => {
      await callTool("manage_target_allocation", { environment: env, ...input });
    });
    if (done) await loadInsight("allocation", env);
    return done;
  }

  /** Draft a stop for every holding without a full one; they open as a basket to review, nothing is sent. */
  async function protectAll(): Promise<void> {
    await run("errorTitleStops", async () => {
      showPayload(await callTool<BasePayload>("review_portfolio_stops", { environment }));
    }, () => void protectAll());
  }

  /** Read a tab. The journal keeps the tag it shows unless `tag` changes it (null shows every trade). */
  async function loadInsight(kind: InsightKind, env = environment, range = period, tag?: string | null, compareWith = benchmark, tax = taxSettings, scopes = historyScopes, custom = customRange): Promise<void> {
    setStatus("loading");
    setProblem(null);
    setInsightError(null);
    const journalFilter = tag === undefined ? journalTag : tag ?? undefined;
    try {
      const scope = kind === "trade_history" || kind === "cash_history" ? scopes[kind] : undefined;
      const zone = tax.timeZone ?? taxZone(tax.yearStart ?? preferences?.taxYearStart, preferences);
      const args = kind === "tax_year" ? { environment: env, ...(tax.year === undefined ? {} : { year: tax.year }), ...(tax.yearStart ? { yearStart: tax.yearStart } : {}), timeZone: zone }
        : timeless(kind) ? { environment: env }
        : {
          environment: env,
          ...(scope?.window ? { ...(scope.window.from ? { from: scope.window.from } : {}), to: scope.window.to } : custom ? { from: custom.exact?.from ?? custom.from, to: custom.exact?.to ?? custom.to } : { period: range }),
          ...(scope?.filter?.ticker ? { ticker: scope.filter.ticker } : {}),
          ...(kind === "cash_history" && scope?.filter?.types ? { types: scope.filter.types } : {}),
          ...(kind === "journal_review" && journalFilter ? { tag: journalFilter } : {}),
          ...(kind === "performance" && compareWith ? { benchmark: compareWith } : {}),
          // Every fill the page can list, and the orders that never filled.
          ...(kind === "trade_history" ? { limit: 200, includeUnfilled: true } : {}),
          ...(kind === "cash_history" ? { limit: 500 } : {}),
        };
      const payload = await callTool<InsightPayload>(INSIGHT_TOOLS[kind], args);
      // The server's settings, first learned here: a year counted in another zone than they give is read again in it.
      if (payload.kind === "tax_year" && payload.preferences) {
        setPreferences(payload.preferences);
        const wanted = taxZone(payload.yearStart, payload.preferences);
        if (!preferences && !tax.timeZone && wanted !== payload.timeZone) return await loadInsight(kind, env, range, tag, compareWith, { ...tax, timeZone: wanted }, scopes, custom);
      }
      if (payload.kind === "journal_review") setJournalTag(payload.tag);
      // A choice holds once a read made with it came back.
      if (payload.kind === "performance" && payload.benchmarkChoice) setBenchmark(payload.benchmarkChoice);
      readFor.current = { ...readFor.current, [kind]: scope?.window ? "host" : readKey(custom, range) };
      setInsights((current) => ({ ...current, [kind]: payload }));
    } catch (requestError) {
      const retry = () => void loadInsight(kind, env, range, tag, compareWith, tax, scopes, custom);
      const failure = problemFrom("errorTitleLoad", requestError, retry);
      // With nothing to show, the error takes the view's place; otherwise the older data stays below it.
      if (insights[kind]) setProblem(failure);
      else setInsightError({ kind, problem: failure });
    } finally {
      setStatus("idle");
    }
  }

  /** Show another tax year, or count it another way; a rule change goes back to the latest year that has started. */
  async function changeTax(next: TaxSettings): Promise<void> {
    setTaxSettings(next);
    await loadInsight("tax_year", environment, period, undefined, benchmark, next);
  }

  async function selectTab(next: PortfolioTab): Promise<void> {
    setTab(next);
    if (isHistory(next)) setHistoryKind(next);
    if (next === "holdings") {
      if (base?.kind !== "portfolio" || base.environment !== environment) await refresh(environment, "holdings");
      return;
    }
    if (stale(next)) await loadInsight(next);
  }

  /** A tab needs reading when it is not loaded, or was read for another period than the switch shows. */
  function stale(kind: InsightKind): boolean {
    const loaded = insights[kind];
    if (!loaded || loaded.environment !== environment) return true;
    if (loaded.kind === "tax_year") {
      const yearStart = taxSettings.yearStart ?? preferences?.taxYearStart ?? loaded.yearStart;
      return loaded.yearStart !== yearStart || loaded.timeZone !== (taxSettings.timeZone ?? taxZone(yearStart, preferences)) || (taxSettings.year !== undefined && loaded.year !== taxSettings.year);
    }
    // A window the host chose stays as read until a period is chosen.
    if ((loaded.kind === "trade_history" || loaded.kind === "cash_history") && historyScopes[loaded.kind]?.window) return false;
    // Read for another period or range than the switch shows now (a window the host read is never one of them).
    return !!periodOfPayload(loaded) && readFor.current[kind] !== readKey(customRange, period);
  }

  async function changePeriod(next: InsightPeriod): Promise<void> {
    setPeriod(next);
    setCustomRange(null);
    // A period chosen replaces a window the host read; an instrument or types it named still hold.
    const scopes = withoutWindows();
    setHistoryScopes(scopes);
    if (tab !== "holdings" && !timeless(tab)) await loadInsight(tab, environment, next, undefined, benchmark, taxSettings, scopes, null);
  }

  /** The scopes with the instrument or types the host named, and no window: the reader chose the days. */
  function withoutWindows(): HistoryScopes {
    return Object.fromEntries(Object.entries(historyScopes).map(([kind, scope]) => [kind, { ...(scope?.filter ? { filter: scope.filter } : {}) }]));
  }

  /** Read the days the reader chose, on this tab and on every other with the period switch as it is opened. */
  async function changeRange(next: DateRange): Promise<void> {
    setCustomRange(next);
    const scopes = withoutWindows();
    setHistoryScopes(scopes);
    if (tab !== "holdings" && !timeless(tab)) await loadInsight(tab, environment, period, undefined, benchmark, taxSettings, scopes, next);
  }

  /** Back to the period the switch had before the range. */
  async function clearRange(): Promise<void> {
    setCustomRange(null);
    if (tab !== "holdings" && !timeless(tab)) await loadInsight(tab, environment, period, undefined, benchmark, taxSettings, historyScopes, null);
  }

  /** Read a trade or cash page again for everything: in the period the switch shows, or all time after the host's own window. */
  async function clearHistoryScope(kind: ScopedKind): Promise<void> {
    const scopes = { ...historyScopes, [kind]: undefined };
    const range = historyScopes[kind]?.window ? "all" : period;
    setHistoryScopes(scopes);
    setPeriod(range);
    await loadInsight(kind, environment, range, undefined, benchmark, taxSettings, scopes);
  }
  const scopeOf = (kind: ScopedKind) => {
    const scope = historyScopes[kind];
    return { period: scope?.window || customRange ? null : period, ...(scope?.filter || scope?.window ? { onClearFilter: () => void clearHistoryScope(kind) } : {}) };
  };

  async function refresh(env = environment, target: PortfolioTab = tab, scopes = historyScopes): Promise<void> {
    if (target !== "holdings" && base?.kind !== "trade_plan" && base?.kind !== "holding") return loadInsight(target, env, period, undefined, benchmark, taxSettings, scopes);
    await run("errorTitleRefresh", async () => {
      if (base?.kind === "holding") {
        setBase(await callTool<HoldingDetail>("app_get_holding", { environment: env, instrument: base.ticker }));
      } else if (base?.kind === "trade_plan") {
        setBase(await callTool<TradePlanPayload>("app_get_trade_plan", {
          environment: env,
          candidates: base.candidates.map(candidateForRefresh),
        }));
      } else {
        setBase(await callTool<DashboardPayload>("app_get_dashboard", { environment: env }));
        setTab("holdings");
      }
    }, () => void refresh(env, target, scopes));
  }

  /** Create, delete or re-arm a price alert, then read the page again so it shows the change. Alerts never trade. */
  async function changeAlert(input: Record<string, unknown>): Promise<boolean> {
    const done = await run("errorTitleAlert", async () => {
      await callTool("manage_price_alerts", { environment, ...input });
    });
    if (!done) return false;
    // The watchlist shows the alerts on its rows; it is read again when it next shows.
    setInsights(({ watchlist: _old, ...rest }) => rest);
    await afterAlert();
    return true;
  }

  /** After an alert changed: the automation tab reads itself again where it shows, and so does a holding page. */
  async function afterAlert(): Promise<void> {
    if (tab === "automation" && base?.kind !== "holding") return loadInsight("automation");
    setInsights(({ automation: _old, ...rest }) => rest);
    if (base?.kind === "holding") await refresh(environment, "holdings");
  }

  /** Create, delete or re-arm an account alert, then read the automation page again. Alerts never trade. */
  async function changeAccountAlert(input: Record<string, unknown>): Promise<boolean> {
    const done = await run("errorTitleAlert", async () => {
      await callTool("manage_account_alerts", { environment, ...input });
    });
    if (!done) return false;
    await afterAlert();
    return true;
  }

  /**
   * Create, change, pause or delete an investment plan, then read the automation page again. Saving a plan places no
   * order. The plan is the automation page's account's, which can lag the switch while the other account's loads.
   */
  /** A test message to each notification endpoint; what each answered. Nothing is traded. */
  async function testNotifications(): Promise<NotifyTestResult[] | undefined> {
    let results: NotifyTestResult[] | undefined;
    await run("errorTitleNotifyTest", async () => {
      results = (await callTool<{ results: NotifyTestResult[] }>("test_notifications", {})).results;
    });
    return results;
  }

  async function changePlan(env: TradingEnvironment, input: Record<string, unknown>, inForm = false): Promise<PlanSaveResult> {
    // A form's failure is said in the form, beside what was typed; the list's buttons report at the top as elsewhere.
    let failure: string | undefined;
    const done = await run("errorTitlePlan", async () => {
      try {
        await callTool("manage_investment_plans", { environment: env, ...input });
      } catch (requestError) {
        failure = problemFrom("errorTitlePlan", requestError).message;
        if (!inForm) throw requestError;
      }
    });
    if (!done || failure !== undefined) return failure ?? t("errorTitlePlan");
    // The page is read again only while it still shows this account; one read under another would be stale.
    if (tab === "automation" && environment === env) await loadInsight("automation", env);
    else setInsights(({ automation: _old, ...rest }) => rest);
    return true;
  }

  /** Open a plan's orders now, as a basket sized at today's prices, to review; nothing is sent until confirmed. */
  async function reviewPlan(planId: string): Promise<void> {
    await run("errorTitlePlanReview", async () => {
      showPayload(await callTool<BasePayload>("review_investment_plan", { planId }));
    }, () => void reviewPlan(planId));
  }

  /**
   * Add, change or delete a trade journal note, then read the page again so it shows the change. Notes never trade.
   * They go to the account of the page shown, which can lag the switch while the other account's page loads.
   */
  async function changeNote(env: TradingEnvironment, input: Record<string, unknown>): Promise<boolean> {
    const done = await run("errorTitleJournal", async () => {
      await callTool("manage_trade_journal", { environment: env, ...input });
    });
    if (!done) return false;
    if (tab === "journal_review" && base?.kind !== "holding" && environment === env) {
      await loadInsight("journal_review", env);
      return true;
    }
    // The journal tab read before no longer matches; it is read again when it next shows.
    setInsights(({ journal_review: _old, ...rest }) => rest);
    if (base?.kind === "holding" && base.environment === env) await refresh(env, "holdings");
    return true;
  }

  /**
   * Add, change the note of, or remove a watchlist instrument; the watchlist never trades. The watchlist tab is read
   * again when shown, and a holding page notes the change in place rather than reading everything again.
   */
  async function changeWatch(env: TradingEnvironment, input: { action: "add" | "note" | "remove"; instrument: string; note?: string }): Promise<boolean> {
    const outcome: { item?: { ticker: string; addedAt: string; note?: string } } = {};
    const done = await run("errorTitleWatchlist", async () => {
      Object.assign(outcome, await callTool<{ item: { ticker: string; addedAt: string; note?: string } }>("manage_watchlist", { environment: env, ...input }));
    });
    if (!done) return false;
    if (tab === "watchlist" && base?.kind !== "holding" && environment === env) {
      await loadInsight("watchlist", env);
      return true;
    }
    setInsights(({ watchlist: _old, ...rest }) => rest);
    const item = outcome.item;
    if (item) {
      setBase((current) => {
        if (current?.kind !== "holding" || current.environment !== env || current.ticker !== item.ticker) return current;
        const { watching: _was, ...rest } = current;
        return input.action === "remove" ? rest : { ...rest, watching: { addedAt: item.addedAt, ...(item.note ? { note: item.note } : {}) } };
      });
    }
    return true;
  }

  /** Trading 212's instruments matching a query, best first, for the watchlist's and the target form's search. */
  async function searchInstruments(query: string, env: TradingEnvironment = environment): Promise<Instrument[]> {
    return (await callTool<{ instruments: Instrument[] }>("search_trading212_instruments", { environment: env, query, limit: 8 })).instruments ?? [];
  }

  /**
   * Open the page a routed result belongs on, for its account. An account without keys shows its setup card; any other
   * failure leaves the problem with a retry, and saved targets whose page cannot be read still say they were saved.
   */
  async function openRoute(payload: RoutedPayload): Promise<void> {
    const env = routeEnvironment(payload);
    const target = ROUTES[payload.kind];
    setLaterRoute(null);
    setEnvironment(env);
    setStatus("loading");
    setProblem(null);
    try {
      showPayload(await callTool<BasePayload>(target === "holdings" ? "app_get_dashboard" : INSIGHT_TOOLS[target], { environment: env }));
    } catch (requestError) {
      if (requestError instanceof ToolCallError && requestError.problem.code === "CREDENTIALS_NOT_CONFIGURED") {
        setBase({ kind: "error", message: requestError.problem.message, error: requestError.problem });
      } else {
        const title = payload.kind === "target_allocation" && payload.targets ? "routeTargetsSaved" : "errorTitleLoad";
        setProblem(problemFrom(title, requestError, () => void openRoute(payload)));
      }
    } finally {
      setStatus("idle");
    }
  }

  /** Look the order up again, as the host's get_order_status did. */
  async function checkOrder(orderId: string, env = environment): Promise<void> {
    await run("errorTitleLoad", async () => {
      setBase(await callTool<BasePayload>("get_order_status", { environment: env, orderId }));
    }, () => void checkOrder(orderId, env));
  }

  /** List Trading 212's CSV reports, or read one; reading downloads it from Trading 212 and adds it up, and requests nothing. */
  async function exportAction(input: { action: "list" } | { action: "read"; reportId: number }, env = environment): Promise<void> {
    await run("errorTitleLoad", async () => {
      setBase(await callTool<BasePayload>("manage_history_export", { environment: env, ...input }));
    }, () => void exportAction(input, env));
  }

  /** Open one holding's detail from the dashboard; Back shows that dashboard again. */
  async function openHolding(ticker: string): Promise<void> {
    await run("errorTitleLoad", async () => {
      const detail = await callTool<HoldingDetail>("app_get_holding", { environment, instrument: ticker });
      setHoldingFrom(base?.kind === "portfolio" ? base : null);
      // The tab views stay hidden behind the holding until Back returns to the one it was opened from.
      setHoldingReturn({ tab, environment });
      setTab("holdings");
      setBase(detail);
    }, () => void openHolding(ticker));
  }

  /** Back from a holding goes to the view it was opened from, in the same account; otherwise to the holdings. */
  function backTab(): PortfolioTab {
    return holdingReturn && holdingReturn.environment === environment ? holdingReturn.tab : "holdings";
  }

  async function backFromHolding(): Promise<void> {
    const returnTab = backTab();
    if (holdingFrom && holdingFrom.environment === environment) {
      setBase(holdingFrom);
      setHoldingFrom(null);
    } else {
      setHoldingFrom(null);
      if (!await run("errorTitleRefresh", async () => {
        setBase(await callTool<DashboardPayload>("app_get_dashboard", { environment }));
      }, () => void backFromHolding())) return;
    }
    setHoldingReturn(null);
    setTab(returnTab);
    // A note written on the holding, or another period chosen meanwhile, reads the tab again.
    if (returnTab !== "holdings" && stale(returnTab)) await loadInsight(returnTab);
  }

  async function switchEnvironment(next: TradingEnvironment): Promise<void> {
    if (next === environment) return;
    // A quantity sized from this account's cash, value or holding is worked out again for the other one. The
    // draft moves only once that works; otherwise it stays on the account it was sized for and the error says why.
    const intent = base?.kind === "order_draft" ? intentForAccount(draft ?? base.draft, base.resolution, next) : undefined;
    const resized: { payload?: BasePayload } = {};
    if (intent && !await run("errorTitleOrderCheck", async () => { resized.payload = await callTool<BasePayload>("review_trading212_order_intent", intent); })) return;
    setEnvironment(next);
    setExecution(null);
    setVerification(null);
    setPreview(null);
    setCancelPreview(null);
    setBasketPreview(null);
    setBasketResult(null);
    setInsights({});
    setInsightError(null);
    // An instrument or window the host named was for the other account; the reads below go without it.
    setHistoryScopes({});
    if (resized.payload) {
      showPayload(resized.payload);
      return;
    }
    if (draft) setDraft({ ...draft, environment: next });
    if (base?.kind === "order_draft") {
      setBase({ ...base, draft: { ...base.draft, environment: next } });
      return;
    }
    await refresh(next, tab, {});
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
      // A risk-sized buy whose price moved after the review, or could not be read at the send, is not sent. Its
      // draft stays in the editor, so the next review shows it at the new price; the used confirmation goes.
      if (!result.ok && result.error && RISK_RECHECK.has(result.error.code)) {
        setPreview(null);
        throw new ToolCallError(result.error);
      }
      setExecution(result);
      setExecutionKind("order");
      setVerification(null);
      setPreview(null);
      setDraft(null);
      // The saved dashboard and tabs no longer match the account; Back from a holding and each tab read again.
      setHoldingFrom(null);
      setInsights({});
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
      setInsights({});
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
      setInsights({});
    });
    // A cancellation opened from an order's own page shows how that order ended.
    if (sent) await (base?.kind === "order_status" ? checkOrder(base.orderId, base.environment) : refresh(environment, "holdings"));
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
  // A trade or cash page the host read for its own window shows that window, not the range.
  const rangeContext = { range: (tab === "trade_history" || tab === "cash_history") && historyScopes[tab]?.window ? null : customRange, onRange: (next: DateRange) => void changeRange(next), onClear: () => void clearRange(), locale };
  const portfolioLike = base?.kind === "portfolio" || isInsight(base);
  // A plan from the allocation shown is for that allocation's account.
  const allocationEnvironment = insights.allocation?.environment ?? environment;
  // Views that read an account: without its API key they would only show an empty account.
  const accountView = portfolioLike || base?.kind === "trade_plan" || base?.kind === "holding";
  const missingCredentials = (accountView && !credentials[environment])
    || (base?.kind === "error" && base.error.code === "CREDENTIALS_NOT_CONFIGURED")
    || (tab !== "holdings" && insightError?.kind === tab && insightError.problem.code === "CREDENTIALS_NOT_CONFIGURED");
  const positions = base?.kind === "portfolio" ? base.positions : [];
  const cancelTarget = cancelPreview ?? (base?.kind === "cancel_draft" && cancelDraftActive ? base : null);
  const fullLabel = displayMode === "fullscreen" ? t("collapse") : t("expand");

  return (
    <div className={`appShell mode-${displayMode}`}>
      {/* A thin sweep along the top while anything loads, so a refresh of a view already shown is seen, not only the spinning icon. */}
      {loading && <span className="loadingBar" aria-hidden="true" />}
      <TipLayer />
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
            {execution.journalEntryId && <span>{t("orderThesisSaved")}</span>}
            {execution.journalNotSaved && <span>{t("orderThesisNotSaved")}</span>}
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
          <RangeContext.Provider value={rangeContext}>
            {base?.kind === "error" && <ErrorCard title={t("errorTitleLoad")} message={formatProblem(base.error, t, locale)} retryLabel={t("retry")} busy={loading} onRetry={() => void refresh(environment, "holdings")} />}
            {portfolioLike && <ViewTabs tab={tab} history={historyKind} busy={loading} t={t} onSelect={(next) => void selectTab(next)} />}
            {base?.kind === "portfolio" && tab === "holdings" && (
              <PortfolioView payload={base} book={book} locale={locale} t={t} writeEnabled={writeEnabled} busy={loading} onCancel={(id) => void startCancel(id)} onOpen={(ticker) => void openHolding(ticker)}
                {...(today && today.key === `${base.environment}:${base.timestamp}` ? { today } : {})}
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
            {portfolioLike && tab === "allocation" && insights.allocation && (
              <AllocationView data={insights.allocation} book={book} locale={locale} t={t} busy={loading}
                {...(insights.allocation.drift && writeEnabled && connected ? { onRebalance: (band?: number) => void rebalanceToTargets(allocationEnvironment, false, band), onInvestCash: () => void rebalanceToTargets(allocationEnvironment, true) } : {})}
                {...(writeEnabled && connected ? { onPlanEqualRisk: (plan: EqualRiskPlan) => void rebalanceToEqualRisk(plan, allocationEnvironment) } : {})}
                {...(connected ? {
                  onSaveTargets: (save: TargetSave) => changeTargets({ action: "set", ...save }, allocationEnvironment),
                  onClearTargets: () => changeTargets({ action: "clear" }, allocationEnvironment),
                  onSearch: (query: string) => searchInstruments(query, allocationEnvironment),
                  ...(insights.allocation.risk ? { onReadCovariance: (measured: MeasuredRisk, alongside: string[]) => readCovariance(allocationEnvironment, measured, alongside) } : {}),
                } : {})} />
            )}
            {portfolioLike && tab === "performance" && insights.performance && (
              <PerformanceView data={insights.performance} book={book} locale={locale} t={t} period={customRange ? null : period} busy={loading} onPeriod={(next) => void changePeriod(next)}
                onOpen={(ticker) => void openHolding(ticker)}
                onBenchmark={(choice) => void loadInsight("performance", environment, period, undefined, choice)} />
            )}
            {portfolioLike && tab === "income" && insights.income && (
              <IncomeView data={insights.income} book={book} locale={locale} t={t} period={customRange ? null : period} busy={loading} onPeriod={(next) => void changePeriod(next)} />
            )}
            {portfolioLike && tab === "journal_review" && insights.journal_review && (
              <JournalReviewView data={insights.journal_review} book={book} locale={locale} t={t} period={customRange ? null : period} busy={loading}
                onPeriod={(next) => void changePeriod(next)} onTag={(tag) => void loadInsight("journal_review", environment, period, tag)}
                onOpen={(ticker) => void openHolding(ticker)} onSaveNote={changeNote} />
            )}
            {portfolioLike && tab === "watchlist" && insights.watchlist && (
              <WatchlistView data={insights.watchlist} book={book} locale={locale} t={t} busy={loading}
                onOpen={(ticker) => void openHolding(ticker)}
                onAdd={(ticker) => changeWatch(environment, { action: "add", instrument: ticker })}
                onRemove={(ticker) => void changeWatch(environment, { action: "remove", instrument: ticker })}
                onNote={(ticker, note) => changeWatch(environment, { action: "note", instrument: ticker, note })}
                onSearch={searchInstruments}
                onRefresh={() => void loadInsight("watchlist")} />
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
                // A new account or instrument starts the page afresh, so an open form cannot save to the wrong one.
                key={`${base.environment}:${base.ticker}`}
                data={base}
                book={book}
                locale={locale}
                t={t}
                writeEnabled={writeEnabled}
                busy={loading}
                {...(backTab() === "holdings" ? {} : { backLabel: t(TAB_KEYS[backTab()]) })}
                onBack={() => void backFromHolding()}
                onSaveAlert={(request) => changeAlert({ action: "create", instrument: base.ticker, ...request })}
                onDeleteAlert={(alertId) => void changeAlert({ action: "delete", alertId })}
                onRearmAlert={(alertId) => void changeAlert({ action: "rearm", alertId })}
                onSaveNote={({ entryId, orderId, thesis, review, tags }) => changeNote(base.environment, entryId
                  ? { action: "update", entryId, thesis, review, tags }
                  : { action: "add", instrument: base.ticker, ...(orderId ? { orderId } : {}), ...(thesis ? { thesis } : {}), ...(review ? { review } : {}), ...(tags.length ? { tags } : {}) })}
                onDeleteNote={(entryId) => void changeNote(base.environment, { action: "delete", entryId })}
                onWatch={(watch) => void changeWatch(base.environment, { action: watch ? "add" : "remove", instrument: base.ticker })}
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
            {portfolioLike && tab === "trade_history" && insights.trade_history && (
              <TradeHistoryView data={insights.trade_history} book={book} locale={locale} t={t} {...scopeOf("trade_history")} busy={loading}
                onPeriod={(next) => void changePeriod(next)} onKind={(next) => void selectTab(next)} onOpen={(ticker) => void openHolding(ticker)} />
            )}
            {portfolioLike && tab === "cash_history" && insights.cash_history && (
              <CashHistoryView data={insights.cash_history} book={book} locale={locale} t={t} {...scopeOf("cash_history")} busy={loading}
                onPeriod={(next) => void changePeriod(next)} onKind={(next) => void selectTab(next)} onOpen={(ticker) => void openHolding(ticker)} />
            )}
            {portfolioLike && tab === "tax_year" && insights.tax_year && (
              <TaxYearView data={insights.tax_year} book={book} locale={locale} t={t} busy={loading} onKind={(next) => void selectTab(next)}
                onYear={(year) => void changeTax({ year, yearStart: insights.tax_year!.yearStart, timeZone: insights.tax_year!.timeZone })}
                onRule={(rule) => void changeTax({ yearStart: TAX_RULES[rule].yearStart, ...(TAX_RULES[rule].timeZone ? { timeZone: TAX_RULES[rule].timeZone } : {}) })} />
            )}
            {portfolioLike && tab === "pies" && insights.pies && <PiesView payload={insights.pies} book={book} locale={locale} t={t} />}
            {portfolioLike && tab === "automation" && insights.automation && (
              <AutomationView data={insights.automation} book={book} locale={locale} t={t} busy={loading}
                onTestNotifications={testNotifications}
                onDeleteAlert={(alertId) => void changeAlert({ action: "delete", alertId })}
                onRearmAlert={(alertId) => void changeAlert({ action: "rearm", alertId })}
                onSaveAccountAlert={(request) => changeAccountAlert({ action: "create", ...request })}
                onDeleteAccountAlert={(alertId) => void changeAccountAlert({ action: "delete", alertId })}
                onRearmAccountAlert={(alertId) => void changeAccountAlert({ action: "rearm", alertId })}
                {...(writeEnabled && credentials[insights.automation.environment] ? {
                  onSavePlan: (request: PlanRequest) => changePlan(insights.automation!.environment, { action: "create", ...request }, true),
                  onChangePlan: (planId: string, changes: Partial<PlanRequest> & { paused?: boolean }, inForm?: boolean) => changePlan(insights.automation!.environment, { action: "update", planId, ...changes }, inForm),
                  onSkipPlan: (planId: string) => void changePlan(insights.automation!.environment, { action: "skip", planId }),
                  onDeletePlan: (planId: string) => void changePlan(insights.automation!.environment, { action: "delete", planId }),
                  onReviewPlan: (planId: string) => void reviewPlan(planId),
                } : {})} />
            )}
            {base?.kind === "order_draft" && !draft && (loading ? <SkeletonView label={t("refreshing")} /> : <div className="emptyState">{t("orderLoaded")}</div>)}
            {base?.kind === "cancel_draft" && (loading
              ? <SkeletonView label={t("refreshing")} />
              : <EmptyRetry text={t("nothingLoaded")} retryLabel={t("retry")} onRetry={() => void refresh(environment, "holdings")} />)}
            {base?.kind === "order_status" && (
              <OrderStatusView data={base} book={book} locale={locale} t={t} busy={loading} writeEnabled={writeEnabled} justCancelled={executionKind === "cancel" && !!execution?.ok}
                onOpen={(ticker) => void openHolding(ticker)} onCancel={(orderId) => void startCancel(orderId, base.environment)}
                onBack={() => void refresh(base.environment, "holdings")} onRefresh={() => void checkOrder(base.orderId, base.environment)} />
            )}
            {base?.kind === "history_export" && (
              <ExportView data={base} locale={locale} t={t} busy={loading} onBack={() => void refresh(base.environment, "holdings")}
                onRead={(reportId) => void exportAction({ action: "read", reportId }, base.environment)} onList={() => void exportAction({ action: "list" }, base.environment)} />
            )}
            {!base && (loading ? <SkeletonView label={t("refreshing")} />
              : laterRoute ? <EmptyRetry text={t("routeEarlier")} retryLabel={t("routeOpen")} onRetry={() => void openRoute(laterRoute)} />
              : !problem && <div className="emptyState">{t("waiting")}</div>)}
          </RangeContext.Provider>
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
