import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useState } from "react";
import type {
  CancelPreview,
  CredentialStatus,
  DashboardPayload,
  EnrichedTradeCandidate,
  Horizon,
  OrderDraft,
  OrderExecutionResult,
  OrderPreview,
  Position,
  TradeCandidate,
  TradePlanPayload,
  TradingEnvironment,
} from "../shared/contracts";
import { APP_META } from "../shared/meta";
import {
  createTranslator,
  localeTag,
  resolveLocale,
  type MessageKey,
  type SupportedLocale,
} from "./i18n";

type BasePayload =
  | DashboardPayload
  | TradePlanPayload
  | {
      kind: "order_draft";
      draft: OrderDraft;
      credentials: CredentialStatus;
      writeEnabled?: boolean;
    }
  | { kind: "error"; message: string };

type Status = "idle" | "loading";
type DisplayMode = "inline" | "fullscreen" | "pip";
type Translator = (key: MessageKey) => string;

const LOCALE_STORAGE_KEY = "tradepilot212.locale";

function readSavedLocale(): SupportedLocale | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === "zh-CN" || value === "en" ? value : null;
  } catch {
    return null;
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

function money(value: number | undefined, currency: string, locale: SupportedLocale): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function num(value: number | undefined, locale: SupportedLocale, digits = 4): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
}

function time(value: string | undefined, locale: SupportedLocale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function signedClass(value: number | undefined): string {
  if (!value) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function walletNumber(position: Position, key: string): number | undefined {
  const value = position.walletImpact?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  };
}

function initialEnvironment(payload: BasePayload | null): TradingEnvironment {
  if (!payload || payload.kind === "error") return "demo";
  if (payload.kind === "order_draft") return payload.draft.environment;
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
  };
}

function Icon({ name }: { name: "refresh" | "expand" | "collapse" | "globe" | "close" | "arrow" }) {
  const paths = {
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6"/></>,
    collapse: <><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    close: <path d="M6 6l12 12M18 6L6 18"/>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
  } as const;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function App() {
  const [base, setBase] = useState<BasePayload | null>(null);
  const [environment, setEnvironment] = useState<TradingEnvironment>("demo");
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [execution, setExecution] = useState<OrderExecutionResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    readSavedLocale() ?? resolveLocale(typeof navigator === "undefined" ? "en" : navigator.language),
  );
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [availableDisplayModes, setAvailableDisplayModes] = useState<DisplayMode[]>(["inline"]);

  const t = useMemo(() => createTranslator(locale), [locale]);

  const { app, error } = useApp({
    appInfo: { name: APP_META.name, version: APP_META.version },
    capabilities: {},
    onAppCreated: (createdApp: McpApp) => {
      const syncHostContext = (context: ReturnType<McpApp["getHostContext"]>) => {
        if (!context) return;
        setDisplayMode((context.displayMode ?? "inline") as DisplayMode);
        setAvailableDisplayModes((context.availableDisplayModes ?? ["inline"]) as DisplayMode[]);
        if (!readSavedLocale()) setLocale(resolveLocale(context.locale));
      };
      syncHostContext(createdApp.getHostContext());
      createdApp.onhostcontextchanged = syncHostContext;
      createdApp.ontoolresult = (toolResult) => {
        const payload = toolResult.structuredContent as unknown as BasePayload;
        if (!payload) return;
        setBase(payload);
        const env = initialEnvironment(payload);
        setEnvironment(env);
        if (payload.kind === "order_draft") setDraft(payload.draft);
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

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
    if (result.isError) throw new Error(textFromToolResult(result));
    return result.structuredContent as unknown as T;
  }

  async function refresh(env = environment): Promise<void> {
    setStatus("loading");
    setErrorMessage(null);
    try {
      if (base?.kind === "trade_plan") {
        setBase(await callTool<TradePlanPayload>("app_get_trade_plan", {
          environment: env,
          candidates: base.candidates.map(candidateForRefresh),
        }));
      } else {
        setBase(await callTool<DashboardPayload>("app_get_dashboard", { environment: env }));
      }
    } catch (requestError) {
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function switchEnvironment(next: TradingEnvironment): Promise<void> {
    if (next === environment) return;
    setEnvironment(next);
    setExecution(null);
    setPreview(null);
    setCancelPreview(null);
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
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function reviewOrder(): Promise<void> {
    if (!draft) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      setPreview(await callTool<OrderPreview>("app_prepare_order", draft as unknown as Record<string, unknown>));
    } catch (requestError) {
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setStatus("idle");
    }
  }

  async function confirmOrder(): Promise<void> {
    if (!preview) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const confirmationCode = preview["token"];
      const result = await callTool<OrderExecutionResult>("app_execute_order", { ["token"]: confirmationCode });
      setExecution(result);
      setPreview(null);
      setDraft(null);
      await refresh(environment);
    } catch (requestError) {
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
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
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
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
      setCancelPreview(null);
      await refresh(environment);
    } catch (requestError) {
      setErrorMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setStatus("idle");
    }
  }

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
              disabled={status === "loading"}
            >
              <span className={`statusDot ${credentials.demo ? "ready" : ""}`} />
              {t("demo")}
            </button>
            <button
              type="button"
              className={environment === "live" ? "active live" : "live"}
              onClick={() => void switchEnvironment("live")}
              disabled={status === "loading"}
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
          <button className="iconAction" type="button" onClick={() => void refresh()} disabled={status === "loading"} title={t("refresh")}>
            <Icon name="refresh" />
            <span className="actionText">{status === "loading" ? t("refreshing") : t("refresh")}</span>
          </button>
        </div>
      </header>

      <div className={`environmentBar ${environment}`}>
        <div>
          <strong>{environment === "live" ? t("liveMoney") : t("demoAccount")}</strong>
          <span>{environment === "live" ? t("liveDescription") : t("demoDescription")}</span>
        </div>
        <span className="connectionBadge"><span className="statusDot ready" />{t("connected")}</span>
      </div>

      {!writeEnabled && base && base.kind !== "error" && (
        <div className="notice warning"><strong>{t("readonlyMode")}</strong><span>{t("readonlyHint")}</span></div>
      )}
      {errorMessage && <div className="notice error"><strong>{t("syncError")}</strong><span>{errorMessage}</span></div>}
      {execution && (
        <div className={`notice ${execution.ok ? "success" : execution.status === "unknown" ? "warning" : "error"}`}>
          <strong>{execution.status === "unknown" ? t("unknownStatus") : execution.ok ? t("submitted") : t("notSubmitted")}</strong>
          <span>{execution.message}</span>
        </div>
      )}

      {base?.kind === "error" && <div className="emptyState">{base.message}</div>}
      {base?.kind === "portfolio" && (
        <PortfolioView payload={base} locale={locale} t={t} writeEnabled={writeEnabled} onCancel={(id) => void startCancel(id)} />
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
      {base?.kind === "order_draft" && !draft && <div className="emptyState">{t("orderLoaded")}</div>}
      {!base && <div className="emptyState">{t("waiting")}</div>}

      {draft && (
        <OrderEditor
          draft={draft}
          locale={locale}
          t={t}
          busy={status === "loading"}
          onChange={setDraft}
          onClose={() => { setDraft(null); setPreview(null); }}
          onReview={() => void reviewOrder()}
        />
      )}

      {preview && (
        <OrderConfirmation
          preview={preview}
          locale={locale}
          t={t}
          busy={status === "loading"}
          onBack={() => setPreview(null)}
          onConfirm={() => void confirmOrder()}
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

function PortfolioView({
  payload,
  locale,
  t,
  writeEnabled,
  onCancel,
}: {
  payload: DashboardPayload;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onCancel: (orderId: string) => void;
}) {
  const currency = payload.account?.currency ?? "EUR";
  const pnl = payload.account?.investments?.unrealizedProfitLoss;
  return (
    <main className="contentStack">
      {payload.warning && <div className="notice warning">{payload.warning}</div>}

      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("accountOverview")}</span>
          <strong className="heroValue">{money(payload.account?.totalValue, currency, locale)}</strong>
          <div className={`pnlBadge ${signedClass(pnl)}`}>{t("unrealizedPnL")} · {money(pnl, currency, locale)}</div>
        </div>
        <div className="metricGrid">
          <Metric label={t("availableCash")} value={money(payload.account?.cash?.availableToTrade, currency, locale)} />
          <Metric label={t("investedValue")} value={money(payload.account?.investments?.currentValue, currency, locale)} />
          <Metric label={t("positions")} value={String(payload.positions.length)} />
          <Metric label={t("lastUpdated")} value={time(payload.timestamp, locale)} compact />
        </div>
      </section>

      <section className="dataPanel">
        <SectionHeader title={t("positions")} count={payload.positions.length} />
        {payload.positions.length === 0 ? (
          <div className="emptyState compact">{t("noPositions")}</div>
        ) : (
          <>
            <div className="desktopTableWrap">
              <table className="positionsTable">
                <thead><tr><th>{t("symbol")}</th><th>{t("quantity")}</th><th>{t("currentPrice")}</th><th>{t("averagePrice")}</th><th>{t("pnl")}</th><th>{t("availableToSell")}</th></tr></thead>
                <tbody>
                  {payload.positions.map((position) => {
                    const positionPnl = walletNumber(position, "unrealizedProfitLoss");
                    return (
                      <tr key={position.instrument.ticker}>
                        <td><AssetIdentity position={position} /></td>
                        <td>{num(position.quantity, locale)}</td>
                        <td>{money(position.currentPrice, position.instrument.currencyCode, locale)}</td>
                        <td>{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</td>
                        <td className={signedClass(positionPnl)}>{money(positionPnl, currency, locale)}</td>
                        <td>{num(position.quantityAvailableForTrading, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobilePositionList">
              {payload.positions.map((position) => (
                <PositionCard key={position.instrument.ticker} position={position} accountCurrency={currency} locale={locale} t={t} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="dataPanel">
        <SectionHeader title={t("pendingOrders")} count={payload.orders.length} />
        {payload.orders.length === 0 ? (
          <div className="emptyState compact">{t("noOrders")}</div>
        ) : (
          <div className="orderList">
            {payload.orders.map((order, index) => {
              const id = String(order.id ?? "");
              return (
                <div className="orderRow" key={id || index}>
                  <div className="orderIdentity"><strong>{order.ticker ?? "—"}</strong><span>{order.type ?? "ORDER"} · {order.status ?? "PENDING"}</span></div>
                  <div className="orderQuantity">{num(typeof order.quantity === "number" ? order.quantity : undefined, locale)}</div>
                  {writeEnabled && <button className="secondaryButton danger" type="button" disabled={!id} onClick={() => id && onCancel(id)}>{t("prepareCancel")}</button>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function AssetIdentity({ position }: { position: Position }) {
  const name = position.instrument.shortName || position.instrument.name || position.instrument.ticker;
  return <div className="assetIdentity"><span className="assetAvatar">{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>{position.instrument.ticker}</small></div></div>;
}

function PositionCard({
  position,
  accountCurrency,
  locale,
  t,
}: {
  position: Position;
  accountCurrency: string;
  locale: SupportedLocale;
  t: Translator;
}) {
  const positionPnl = walletNumber(position, "unrealizedProfitLoss");
  const positionValue = walletNumber(position, "currentValue");
  return (
    <article className="positionCard">
      <div className="positionCardHeader"><AssetIdentity position={position} /><span className={`compactPnl ${signedClass(positionPnl)}`}>{money(positionPnl, accountCurrency, locale)}</span></div>
      <div className="positionFacts">
        <div><span>{t("positionValue")}</span><strong>{money(positionValue, accountCurrency, locale)}</strong></div>
        <div><span>{t("currentPrice")}</span><strong>{money(position.currentPrice, position.instrument.currencyCode, locale)}</strong></div>
        <div><span>{t("quantity")}</span><strong>{num(position.quantity, locale)}</strong></div>
        <div><span>{t("averagePrice")}</span><strong>{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</strong></div>
      </div>
    </article>
  );
}

function TradePlanView({
  payload,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  payload: TradePlanPayload;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onTrade: (candidate: EnrichedTradeCandidate) => void;
}) {
  const [activeHorizon, setActiveHorizon] = useState<Horizon>("short");
  useEffect(() => {
    if (payload.candidates.some((candidate) => candidate.horizon === activeHorizon)) return;
    const first = (["short", "medium", "long"] as Horizon[]).find((horizon) => payload.candidates.some((candidate) => candidate.horizon === horizon));
    if (first) setActiveHorizon(first);
  }, [activeHorizon, payload.candidates]);
  const groups: Array<{ key: Horizon; label: string; hint: string }> = [
    { key: "short", label: t("short"), hint: t("shortHint") },
    { key: "medium", label: t("medium"), hint: t("mediumHint") },
    { key: "long", label: t("long"), hint: t("longHint") },
  ];
  const visible = payload.candidates.filter((candidate) => candidate.horizon === activeHorizon);
  const currency = payload.account?.currency ?? "EUR";
  return (
    <main className="contentStack">
      <section className="overviewPanel tradeOverview">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("tradePlan")}</span>
          <strong className="heroValue small">{payload.candidates.length} {t("candidates")}</strong>
          <span className="overviewSubline">{t("account")} · {payload.environment.toUpperCase()}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("totalValue")} value={money(payload.account?.totalValue, currency, locale)} />
          <Metric label={t("availableCash")} value={money(payload.account?.cash?.availableToTrade, currency, locale)} />
          <Metric label={t("unrealizedPnL")} value={money(payload.account?.investments?.unrealizedProfitLoss, currency, locale)} />
          <Metric label={t("lastUpdated")} value={time(payload.timestamp, locale)} compact />
        </div>
      </section>

      <section className="dataPanel tradePanel">
        <div className="horizonTabs" role="tablist">
          {groups.map((group) => {
            const count = payload.candidates.filter((candidate) => candidate.horizon === group.key).length;
            return (
              <button key={group.key} type="button" role="tab" aria-selected={activeHorizon === group.key} className={activeHorizon === group.key ? "active" : ""} onClick={() => setActiveHorizon(group.key)}>
                <span>{group.label}</span><small>{group.hint}</small><b>{count}</b>
              </button>
            );
          })}
        </div>
        {visible.length === 0 ? <div className="emptyState compact">{t("candidates")} · 0</div> : (
          <div className="candidateGrid">
            {visible.map((candidate, index) => (
              <CandidateCard
                key={`${candidate.resolvedInstrument?.ticker ?? candidate.ticker ?? candidate.symbol}-${index}`}
                candidate={candidate}
                locale={locale}
                t={t}
                writeEnabled={writeEnabled}
                onTrade={onTrade}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function CandidateCard({
  candidate,
  locale,
  t,
  writeEnabled,
  onTrade,
}: {
  candidate: EnrichedTradeCandidate;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onTrade: (candidate: EnrichedTradeCandidate) => void;
}) {
  const instrument = candidate.resolvedInstrument;
  const actionKey: MessageKey = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  const riskKey: MessageKey = candidate.risk === "low" ? "low" : candidate.risk === "high" ? "high" : "mediumRisk";
  const actionClass = candidate.action === "buy" ? "buy" : candidate.action === "sell" ? "sell" : "watch";
  return (
    <article className="candidateCard">
      <div className="candidateTopline">
        <div className="candidateIdentity">
          <span className="assetAvatar">{(instrument?.shortName || candidate.symbol || candidate.ticker || candidate.name || "?").slice(0, 2).toUpperCase()}</span>
          <div><strong>{instrument?.shortName || candidate.symbol || candidate.ticker || candidate.name}</strong><small>{instrument?.ticker || candidate.ticker || "—"}</small></div>
        </div>
        <div className={`scoreRing ${candidate.score >= 80 ? "high" : candidate.score >= 65 ? "medium" : "low"}`}><strong>{candidate.score}</strong><span>{t("score")}</span></div>
      </div>
      <div className="candidateBadges">
        <span className={`actionBadge ${actionClass}`}>{t(actionKey)}</span>
        <span>{t("risk")} · {t(riskKey)}</span>
        {candidate.referencePrice && <span>{t("reference")} · {money(candidate.referencePrice, instrument?.currencyCode ?? "USD", locale)}</span>}
      </div>
      <p className="candidateRationale">{candidate.rationale}</p>
      {candidate.resolutionError && <div className="inlineError">{candidate.resolutionError}</div>}
      {(candidate.heldQuantity !== undefined || candidate.availableToSell !== undefined) && (
        <div className="candidateHolding"><span>{t("holding")}</span><strong>{num(candidate.heldQuantity, locale)}</strong><span>· {t("availableToSell")}</span><strong>{num(candidate.availableToSell, locale)}</strong></div>
      )}
      <button
        className={`tradeButton ${actionClass}`}
        type="button"
        disabled={!writeEnabled || candidate.action === "watch" || !instrument}
        onClick={() => onTrade(candidate)}
      >
        <span>{candidate.action === "watch" ? t("keepWatching") : candidate.action === "sell" ? t("prepareSell") : t("prepareBuy")}</span>
        {candidate.action !== "watch" && <Icon name="arrow" />}
      </button>
    </article>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={`metric ${compact ? "compact" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return <div className="sectionHeader"><h2>{title}</h2><span>{count}</span></div>;
}

function OrderEditor({
  draft,
  locale,
  t,
  busy,
  onChange,
  onClose,
  onReview,
}: {
  draft: OrderDraft;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onChange: (draft: OrderDraft) => void;
  onClose: () => void;
  onReview: () => void;
}) {
  const set = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <div className="modalBackdrop" role="presentation">
      <section className={`dialogPanel ${draft.environment === "live" ? "liveDialog" : ""}`} role="dialog" aria-modal="true" aria-label={t("orderDraft")}>
        <div className="dialogHeader">
          <div><span className={`environmentTag ${draft.environment}`}>{draft.environment.toUpperCase()}</span><h2>{t("orderDraft")}</h2><p>{draft.ticker}</p></div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        <div className="formGrid">
          <Field label={t("side")}><select value={draft.side} onChange={(event) => set("side", event.target.value as OrderDraft["side"])}><option value="buy">{t("buy")}</option><option value="sell">{t("sell")}</option></select></Field>
          <Field label={t("type")}><select value={draft.type} onChange={(event) => set("type", event.target.value as OrderDraft["type"])}><option value="market">{t("market")}</option><option value="limit">{t("limit")}</option><option value="stop">{t("stop")}</option><option value="stop_limit">{t("stopLimit")}</option></select></Field>
          <Field label={t("quantity")}><input type="number" min="0" step="any" value={draft.quantity} onChange={(event) => set("quantity", Number(event.target.value))} /></Field>
          <Field label={t("referencePrice")}><input type="number" min="0" step="any" value={draft.referencePrice ?? ""} placeholder="—" onChange={(event) => set("referencePrice", event.target.value ? Number(event.target.value) : undefined)} /></Field>
          {(draft.type === "limit" || draft.type === "stop_limit") && <Field label={t("limitPrice")}><input type="number" min="0" step="any" value={draft.limitPrice ?? ""} onChange={(event) => set("limitPrice", event.target.value ? Number(event.target.value) : undefined)} /></Field>}
          {(draft.type === "stop" || draft.type === "stop_limit") && <Field label={t("stopPrice")}><input type="number" min="0" step="any" value={draft.stopPrice ?? ""} onChange={(event) => set("stopPrice", event.target.value ? Number(event.target.value) : undefined)} /></Field>}
          {draft.type !== "market" && <Field label={t("validity")}><select value={draft.timeValidity ?? "DAY"} onChange={(event) => set("timeValidity", event.target.value as OrderDraft["timeValidity"])}><option value="DAY">{t("day")}</option><option value="GOOD_TILL_CANCEL">{t("gtc")}</option></select></Field>}
          {draft.type === "market" && <label className="toggleField"><input type="checkbox" checked={draft.extendedHours ?? false} onChange={(event) => set("extendedHours", event.target.checked)} /><span className="toggleTrack"><span /></span><span>{t("extendedHours")}</span></label>}
        </div>
        <div className="dialogFooter"><button className="secondaryButton" onClick={onClose}>{t("cancel")}</button><button className="primaryButton" disabled={busy} onClick={onReview}>{busy ? t("checking") : t("reviewOrder")}</button></div>
        <span className="visuallyHidden">{locale}</span>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function OrderConfirmation({
  preview,
  locale,
  t,
  busy,
  onBack,
  onConfirm,
}: {
  preview: OrderPreview;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const draft = preview.draft;
  const amountCurrency = preview.estimatedNotionalCurrency || preview.instrument.currencyCode;
  return (
    <div className="modalBackdrop topLayer">
      <section className={`dialogPanel confirmationPanel ${draft.environment === "live" ? "liveDialog" : ""}`} role="dialog" aria-modal="true">
        <div className="confirmationHero">
          <span className={`environmentTag ${draft.environment}`}>{draft.environment.toUpperCase()}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")}</span>
          <h2>{draft.environment === "live" ? t("realOrder") : t("demoOrder")}</h2>
          <strong className="confirmationAmount">{money(preview.estimatedNotional, amountCurrency, locale)}</strong>
        </div>
        <div className="confirmationRows">
          <DetailRow label={t("instrument")} value={`${preview.instrument.shortName || preview.instrument.name} · ${draft.ticker}`} />
          <DetailRow label={t("side")} value={draft.side === "buy" ? t("buy") : t("sell")} />
          <DetailRow label={t("type")} value={draft.type === "market" ? t("market") : draft.type === "limit" ? t("limit") : draft.type === "stop" ? t("stop") : t("stopLimit")} />
          <DetailRow label={t("quantity")} value={num(draft.quantity, locale)} />
          {draft.limitPrice && <DetailRow label={t("limitPrice")} value={num(draft.limitPrice, locale)} />}
          {draft.stopPrice && <DetailRow label={t("stopPrice")} value={num(draft.stopPrice, locale)} />}
        </div>
        {preview.warnings.map((warning) => <div className="notice warning compactNotice" key={warning}>{warning}</div>)}
        <div className="expiryLine">{t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        <div className="dialogFooter"><button className="secondaryButton" onClick={onBack}>{t("backToEdit")}</button><button className={draft.environment === "live" ? "dangerButton" : "primaryButton"} disabled={busy} onClick={onConfirm}>{busy ? t("submitting") : draft.environment === "live" ? t("confirmLive") : t("confirmDemo")}</button></div>
      </section>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function ConfirmModal({
  title,
  body,
  danger,
  confirmLabel,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  danger: boolean;
  confirmLabel: string;
  busy: boolean;
  t: Translator;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modalBackdrop topLayer">
      <section className={`dialogPanel smallDialog ${danger ? "liveDialog" : ""}`} role="dialog" aria-modal="true">
        <h2>{title}</h2><p>{body}</p>
        <div className="dialogFooter"><button className="secondaryButton" onClick={onCancel}>{t("back")}</button><button className={danger ? "dangerButton" : "primaryButton"} disabled={busy} onClick={onConfirm}>{busy ? t("processing") : confirmLabel}</button></div>
      </section>
    </div>
  );
}

