import { Fragment, useRef, useState, type ReactNode } from "react";
import type { ActivityEvent, DashboardPayload, PendingOrder, Position } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import type { ValuePoint } from "../../shared/history";
import { portfolioProtection, stopProtection } from "../../shared/protection";
import { AssetIdentity, Metric, SectionHeader } from "../components/common";
import { Select } from "../components/select";
import { Sparkline } from "../components/charts";
import { DayCell, DayTotal, type TodayState } from "../components/day";
import { GoalProgressLine } from "../components/goal";
import { HoldingsMap, mapDayKnown } from "../components/holdings-map";
import { FxPart, fxShown, ResultSplitBars } from "../components/result-split";
import { resultSplit, resultSplitOf } from "../../shared/result-split";
import type { DayMove } from "../../shared/today";
import { amount, dateTime, dayLabel, money, num, pct, qty, signedClass, time, walletNumber } from "../lib/format";
import { ageText, MAX_FAILURES, useNow } from "../lib/auto-refresh";
import { nextSort, readHoldingsPrefs, saveHoldingsPrefs, SORT_CHOICES, sortFromId, sortHoldings, sortId, type HoldingsPrefs, type HoldingsSortKey } from "../lib/holdings";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import type { MessageKey } from "../i18n";
import { activityLabel, activityNeedsAttention, countText, envLabel, fill, type Translator } from "../lib/messages";
import { stopCoverageText, stopGuardText, summarizeOrder } from "../lib/orders";
import { radioKeys, radioTab } from "../lib/radio";

export type { TodayState };

/** The dashboard reading itself again, as App runs it: the reader's switch, and how the last reads went. */
export interface AutoRefreshState {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Reads that failed in a row, and why the last one did. */
  failures: number;
  problem?: string;
}

/** The dashboard's figures a read can move, keyed by figure: the account's total, and each holding's price and value. */
export function dashboardFigures(payload: DashboardPayload): Map<string, number> {
  const values = new Map<string, number>();
  const put = (key: string, value: number | undefined) => { if (value !== undefined && Number.isFinite(value)) values.set(key, value); };
  put("total", payload.account?.totalValue);
  for (const position of payload.positions) {
    put(`price:${position.instrument.ticker}`, position.currentPrice);
    put(`value:${position.instrument.ticker}`, walletNumber(position, "currentValue"));
  }
  return values;
}

/** Which way each figure in both reads moved from the first to the second. */
export function figuresMoved(before: Map<string, number>, after: Map<string, number>): Map<string, "up" | "down"> {
  const moved = new Map<string, "up" | "down">();
  for (const [key, value] of after) {
    const old = before.get(key);
    if (old !== undefined && old !== value) moved.set(key, value > old ? "up" : "down");
  }
  return moved;
}

/** Which way each figure moved since the dashboard before this one (same account), keyed by the figure. */
type Moved = (key: string) => "up" | "down" | undefined;
function useMoved(payload: DashboardPayload): Moved {
  const last = useRef<{ stamp: string; environment: string; values: Map<string, number>; moved: Map<string, "up" | "down"> } | null>(null);
  if (last.current?.stamp !== payload.timestamp) {
    const values = dashboardFigures(payload);
    const before = last.current;
    const moved = before && before.environment === payload.environment ? figuresMoved(before.values, values) : new Map<string, "up" | "down">();
    last.current = { stamp: payload.timestamp, environment: payload.environment, values, moved };
  }
  const moved = last.current.moved;
  return (key) => moved.get(key);
}

/**
 * A figure that changed since the last read, lit for a moment in the colour of its move: keyed by the read, so each
 * read that moves it lights it again.
 */
function Lit({ moved, stamp, children }: { moved: "up" | "down" | undefined; stamp: string; children: ReactNode }) {
  return moved ? <span key={stamp} className={`litFigure ${moved}`}>{children}</span> : <>{children}</>;
}

const SORT_NAMES: Record<string, MessageKey> = {
  default: "sortDefault", "value-desc": "sortValueDesc", "value-asc": "sortValueAsc", "day-desc": "sortDayDesc", "day-asc": "sortDayAsc",
  "pnl-desc": "sortPnlDesc", "pnl-asc": "sortPnlAsc", "name-asc": "sortNameAsc",
};

export function PortfolioView({
  payload,
  book,
  locale,
  t,
  writeEnabled,
  busy = false,
  onCancel,
  onOpen,
  onProtectAll,
  today,
  onGoal,
  auto,
}: {
  payload: DashboardPayload;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  busy?: boolean;
  onCancel: (orderId: string) => void;
  /** Opens one holding's detail. */
  onOpen?: (ticker: string) => void;
  /** Drafts a stop for every holding without a full one, as a basket to review; nothing is sent from here. */
  onProtectAll?: () => void;
  /** The day's moves, read after the dashboard; none when they are not asked for. */
  today?: TodayState;
  /** Opens the Performance tab at the investment goal. */
  onGoal?: () => void;
  /** The dashboard reading itself again; none for one that is not read again (an old chat's). */
  auto?: AutoRefreshState;
}) {
  const moved = useMoved(payload);
  const stamp = payload.timestamp;
  const currency = payload.account?.currency ?? "EUR";
  const pnl = payload.account?.investments?.unrealizedProfitLoss;
  // The exchange rates' part of it, over every holding; the price part is the rest, so the two add up to the badge.
  const fx = resultSplitOf(payload.positions)?.fx;
  const moves = new Map((today?.data?.moves ?? []).map((move) => [move.ticker, move]));
  const soldOut = (today?.data?.moves ?? []).filter((move) => move.quantity === 0 && move.profitLoss !== undefined);
  /** The holdings' day, unless its read failed. */
  const day = today && !today.failed ? today : undefined;
  const [prefs, setPrefs] = useState(readHoldingsPrefs);
  const choose = (next: Partial<HoldingsPrefs>) => setPrefs((current) => {
    const updated = { ...current, ...next };
    saveHoldingsPrefs(updated);
    return updated;
  });
  // Without the day's moves there is nothing to sort or colour by on the day.
  const dayKnown = mapDayKnown(today);
  const sort = prefs.sort?.key === "day" && !dayKnown ? undefined : prefs.sort;
  const measure = dayKnown ? prefs.measure : "total";
  const positions = sortHoldings(payload.positions, sort, moves, book, locale);
  /** A column header that sorts by it, saying which way it is sorted now. */
  const header = (key: HoldingsSortKey, label: ReactNode, className?: string) => {
    const active = sort?.key === key ? sort.direction : undefined;
    return (
      <th {...(className ? { className } : {})} aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : "none"}>
        <button type="button" className={`sortHeader${active ? " active" : ""}`} onClick={() => choose({ sort: nextSort(sort, key) })}>
          {label}{active && <span className="sortArrow" aria-hidden="true">{active === "asc" ? "↑" : "↓"}</span>}
        </button>
      </th>
    );
  };
  return (
    <main className="contentStack">
      {payload.warning && <div className="notice warning">{payload.warning}</div>}

      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("accountOverview")}</span>
          <strong className="heroValue"><Lit moved={moved("total")} stamp={stamp}>{money(payload.account?.totalValue, currency, locale)}</Lit></strong>
          <div className={`pnlBadge ${signedClass(pnl)}`}>{t("unrealizedPnL")} · {money(pnl, currency, locale, { signed: true })}</div>
          {pnl !== undefined && fxShown(fx) && <ResultSplitBars price={pnl - fx} fx={fx} currency={currency} locale={locale} t={t} />}
          {today && <DayTotal today={today} currency={currency} locale={locale} t={t} />}
          {payload.valueTrend && payload.valueTrend.length >= 2 && <ValueTrend points={payload.valueTrend} currency={currency} locale={locale} t={t} />}
          {payload.goal && <GoalProgressLine goal={payload.goal} {...(payload.account?.totalValue === undefined ? {} : { value: payload.account.totalValue })} currency={currency} locale={locale} t={t} {...(onGoal ? { onOpen: onGoal } : {})} />}
        </div>
        <div className="metricGrid">
          <Metric label={t("availableCash")} value={money(payload.account?.cash?.availableToTrade, currency, locale)} />
          <Metric label={t("investedValue")} value={money(payload.account?.investments?.currentValue, currency, locale)} />
          <Metric label={t("positions")} value={String(payload.positions.length)} />
          <UpdatedMetric timestamp={payload.timestamp} locale={locale} t={t} {...(auto ? { auto } : {})} />
        </div>
      </section>

      <section className="dataPanel">
        <SectionHeader title={t("positions")} count={payload.positions.length} />
        <ProtectionBar positions={payload.positions} orders={payload.orders} currency={currency} locale={locale} t={t} busy={busy} {...(onProtectAll ? { onProtectAll } : {})} />
        {payload.positions.length === 0 ? (
          <div className="emptyState compact">{t("noPositions")}</div>
        ) : (
          <>
            <div className="holdingsToolbar">
              <div className="segmented" role="radiogroup" onKeyDown={radioKeys} aria-label={t("holdingsShow")}>
                {(["table", "map"] as const).map((view) => (
                  <button key={view} type="button" role="radio" aria-checked={prefs.view === view} tabIndex={radioTab(prefs.view === view)} className={prefs.view === view ? "active" : ""} onClick={() => choose({ view })}>{t(view === "table" ? "viewTable" : "viewMap")}</button>
                ))}
              </div>
              {prefs.view === "map" ? (
                <div className="segmented" role="radiogroup" onKeyDown={radioKeys} aria-label={t("mapColour")}>
                  {(["day", "total"] as const).map((key) => (
                    <button key={key} type="button" role="radio" aria-checked={measure === key} tabIndex={radioTab(measure === key)} className={measure === key ? "active" : ""} disabled={key === "day" && !dayKnown}
                      onClick={() => choose({ measure: key })}>{t(key === "day" ? "mapDay" : "mapTotal")}</button>
                  ))}
                </div>
              ) : (
                <div className="sortSelect">
                  <span aria-hidden="true">{t("sortLabel")}</span>
                  <Select value={sortId(sort)} label={t("sortLabel")} onChange={(id) => choose({ sort: sortFromId(id) })}
                    options={[undefined, ...SORT_CHOICES].filter((choice) => dayKnown || choice?.key !== "day").map((choice) => ({ value: sortId(choice), label: t(SORT_NAMES[sortId(choice)]!) }))} />
                </div>
              )}
            </div>
            {prefs.view === "map" ? (
              <HoldingsMap positions={payload.positions} moves={moves} {...(today ? { today } : {})} measure={measure} currency={currency} book={book} locale={locale} t={t} {...(onOpen ? { onOpen } : {})} />
            ) : (<>
            <div className="desktopTableWrap">
              <table className="positionsTable">
                <thead><tr>{header("name", t("symbol"))}<th>{t("quantity")}</th><th>{t("currentPrice")}</th>{day && (dayKnown ? header("day", t("todayColumn"), "dayColumn") : <th className="dayColumn">{t("todayColumn")}</th>)}<th className="optionalColumn">{t("averagePrice")}</th>{header("value", t("positionValue"))}{header("pnl", t("pnl"))}<th className="optionalColumn stopColumn">{t("stopLoss")}</th></tr></thead>
                <tbody>
                  {positions.map((position) => {
                    const positionPnl = walletNumber(position, "unrealizedProfitLoss");
                    const guard = stopProtection(position, payload.orders);
                    return (
                      <tr key={position.instrument.ticker}>
                        <td>
                          {onOpen ? <OpenHolding position={position} book={book} t={t} onOpen={onOpen} /> : <AssetIdentity position={position} book={book} />}
                          {/* Where the stop-loss column is hidden, the stop shows under the name. */}
                          {guard && <small className="stopInline">{t("stopLoss")} {stopGuardText(guard, position, locale, t)}{guard.coverage < 1 ? ` · ${stopCoverageText(guard, position, locale, t)}` : ""}</small>}
                        </td>
                        <td>
                          {qty(position.quantity, locale)}
                          {/* Shares held in pies or by a pending sell are not free to sell; the holding's page has the detail. */}
                          {position.quantityAvailableForTrading < position.quantity && <small className="freeToSell">{fill(t("freeToSell"), { quantity: qty(position.quantityAvailableForTrading, locale) })}</small>}
                        </td>
                        <td>
                          <Lit moved={moved(`price:${position.instrument.ticker}`)} stamp={stamp}>{money(position.currentPrice, position.instrument.currencyCode, locale)}</Lit>
                          {/* Where the Day column is hidden, the day's move shows under the price. */}
                          {day && <span className="dayUnderPrice"><DayCell move={moves.get(position.instrument.ticker)} loading={day.loading} currency={currency} locale={locale} t={t} layout="row" /></span>}
                        </td>
                        {day && <td className="dayColumn"><DayCell move={moves.get(position.instrument.ticker)} loading={day.loading} currency={currency} locale={locale} t={t} /></td>}
                        <td className="optionalColumn">{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</td>
                        <td><Lit moved={moved(`value:${position.instrument.ticker}`)} stamp={stamp}>{money(walletNumber(position, "currentValue"), currency, locale)}</Lit></td>
                        <td className={signedClass(positionPnl)}>{money(positionPnl, currency, locale, { signed: true })}<FxPart fx={resultSplit(position)?.fx} currency={currency} locale={locale} t={t} /></td>
                        <td className="optionalColumn stopColumn">{guard ? <span className="stopCell"><strong>{stopGuardText(guard, position, locale, t)}</strong><small>{stopCoverageText(guard, position, locale, t)}</small></span> : <span className="mutedInline" aria-label={t("noStopLoss")}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobilePositionList">
              {positions.map((position) => (
                <PositionCard key={position.instrument.ticker} position={position} orders={payload.orders} accountCurrency={currency} book={book} locale={locale} t={t} {...(onOpen ? { onOpen } : {})}
                  moved={{ price: moved(`price:${position.instrument.ticker}`), value: moved(`value:${position.instrument.ticker}`), stamp }}
                  {...(day ? { day: { move: moves.get(position.instrument.ticker), loading: day.loading } } : {})} />
              ))}
            </div>
            </>)}
            {soldOut.length > 0 && (
              <p className="panelNote">{fill(t("todaySoldOut"), {
                items: soldOut.map((move) => `${instrumentLabel(move.ticker, book, move).name} ${money(move.profitLoss, currency, locale, { signed: true })}`).join(", "),
              })}</p>
            )}
          </>
        )}
      </section>

      <section className="dataPanel">
        <SectionHeader title={t("pendingOrders")} count={payload.orders.length} />
        <PendingOrderList orders={payload.orders} positions={payload.positions} book={book} locale={locale} t={t} writeEnabled={writeEnabled} onCancel={onCancel} />
      </section>

      <ActivityPanel activity={payload.activity ?? []} book={book} locale={locale} t={t} />
    </main>
  );
}

/** Stop-loss coverage across the holdings, with one basket for the rest when order tools are on. */
function ProtectionBar({ positions, orders, currency, locale, t, busy, onProtectAll }: {
  positions: Position[];
  orders: PendingOrder[];
  currency: string;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onProtectAll?: () => void;
}) {
  const summary = portfolioProtection(positions, orders);
  if (!summary.holdings) return null;
  const full = summary.covered === summary.holdings;
  // What the stops already in place would cost from here: the downside they still leave.
  // A stop-limit is counted at its limit, which it reaches only if it fills, so the line says so.
  const atStopsKey = summary.atStopsLimited
    ? (summary.atStopsShare === undefined ? "protectionAtStopsFillsShort" : "protectionAtStopsFills")
    : (summary.atStopsShare === undefined ? "protectionAtStopsShort" : "protectionAtStops");
  const atStops = summary.atStops === undefined ? [] : [fill(t(atStopsKey), {
    change: money(-summary.atStops, currency, locale, { signed: true }),
    share: pct(summary.atStopsShare, locale, 1),
  })];
  const parts = full ? [t("protectionAll"), ...atStops] : [
    fill(t("protectionSummary"), { covered: num(summary.covered, locale), holdings: num(summary.holdings, locale) }),
    ...(summary.unprotectedValue === undefined ? [] : [fill(t("protectionUnprotected"), { value: money(summary.unprotectedValue, currency, locale), share: pct(summary.unprotectedShare, locale, 0) })]),
    ...atStops,
  ];
  return (
    <div className="protectionBar">
      <span className="guardText">
        {/* Each part wraps as a whole where it can, so a narrow screen breaks the line at the "·"; the mark stays with the first. */}
        {parts.map((part, index) => (
          <Fragment key={index}>{index > 0 && " · "}<span className="guardPart">{index === 0 && <span className="positionGuardMark" aria-hidden="true" />}{part}</span></Fragment>
        ))}
      </span>
      {onProtectAll && summary.protectable > 0 && (
        <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={onProtectAll}>{summary.covered + summary.partial ? t("protectRest") : t("addStopLosses")}</button>
      )}
    </div>
  );
}

/** Pending orders with their prices, status and distance from the last price, each with a cancel button when writes are on. */
export function PendingOrderList({ orders, positions, book, locale, t, writeEnabled, onCancel }: {
  orders: PendingOrder[];
  positions: Position[];
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onCancel: (orderId: string) => void;
}) {
  if (orders.length === 0) return <div className="emptyState compact">{t("noOrders")}</div>;
  return (
    <div className="orderList">
      {orders.map((order, index) => {
        const id = String(order.id ?? "");
        const row = summarizeOrder(order, t, locale, positions, book);
        const detail = [row.type, ...row.prices, row.validity, row.detail, row.status].filter(Boolean).join(" · ");
        return (
          <div className="orderRow" key={id || index}>
            <div className="orderIdentity" title={row.ticker}>
              <strong>{row.name}</strong>
              <span><b className={`orderSide ${row.side}`}>{row.side === "sell" ? t("sell") : t("buy")}</b> · {detail}</span>
              {row.distance && <span className="orderDistance">{row.distance}</span>}
            </div>
            <div className="orderQuantity">{qty(row.quantity, locale)}</div>
            {writeEnabled && <button className="secondaryButton danger" type="button" data-focus-id={`cancel-${id}`} disabled={!id} onClick={() => id && onCancel(id)}>{t("prepareCancel")}</button>}
          </div>
        );
      })}
    </div>
  );
}

/** A holding's name as a button that opens its detail. */
function OpenHolding({ position, book, t, onOpen }: { position: Position; book?: InstrumentBook; t: Translator; onOpen: (ticker: string) => void }) {
  const label = instrumentLabel(position.instrument.ticker, book, position.instrument);
  return (
    <button type="button" className="holdingOpen" aria-label={fill(t("openHolding"), { name: label.name })} onClick={() => onOpen(position.instrument.ticker)}>
      <AssetIdentity position={position} book={book} />
      <span className="holdingOpenChevron" aria-hidden="true">›</span>
    </button>
  );
}

/** Shares, average price and value of a fill event, in the widget's language. */
function fillFacts(event: ActivityEvent, locale: SupportedLocale, t: Translator): string | undefined {
  if (event.filledQuantity === undefined) return undefined;
  const filled = qty(event.filledQuantity, locale);
  return [
    event.type === "order_partly_filled" && event.quantity ? fill(t("activityFilledOf"), { filled, ordered: qty(event.quantity, locale) }) : fill(t("activityFilled"), { filled }),
    event.price === undefined ? undefined : fill(t("activityAveragePrice"), { price: num(event.price, locale, 6) }),
    event.value === undefined ? undefined : amount(event.value, event.valueCurrency, locale),
  ].filter(Boolean).join(" · ");
}

export function ActivityPanel({ activity, book, locale, t }: { activity: ActivityEvent[]; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  return (
    <section className="dataPanel activityPanel">
      <details>
        <summary><span>{t("recentActivity")}</span><b>{activity.length}</b></summary>
        {activity.length === 0 ? <div className="emptyState compact">{t("noActivity")}</div> : (
          <div className="activityList">
            {activity.map((event) => {
              const facts = fillFacts(event, locale, t);
              return (
                <div className="activityRow" key={event.id}>
                  <span className={`activityDot ${activityNeedsAttention(event) ? "warning" : ""}`} aria-hidden="true" />
                  <div>
                    <strong>{activityLabel(event, t)}</strong>
                    <small>{[event.ticker ? instrumentLabel(event.ticker, book).name : undefined, event.orderId, event.legs ? countText("orders", event.legs, t, locale) : undefined, event.planId].filter(Boolean).join(" · ") || envLabel(event.environment, t)}</small>
                    {facts && <small>{facts}</small>}
                  </div>
                  <time dateTime={event.timestamp}>{time(event.timestamp, locale)}</time>
                </div>
              );
            })}
          </div>
        )}
      </details>
    </section>
  );
}

export function PositionCard({
  position,
  orders = [],
  accountCurrency,
  book,
  locale,
  t,
  onOpen,
  day,
  moved,
}: {
  position: Position;
  /** Pending orders; a sell stop on this holding shows under its facts. */
  orders?: PendingOrder[];
  accountCurrency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onOpen?: (ticker: string) => void;
  /** The holding's move on the day, when the dashboard reads them. */
  day?: { move: DayMove | undefined; loading: boolean };
  /** Which way the value and price moved since the last read, and that read. */
  moved?: { price?: "up" | "down" | undefined; value?: "up" | "down" | undefined; stamp: string };
}) {
  const positionPnl = walletNumber(position, "unrealizedProfitLoss");
  const positionValue = walletNumber(position, "currentValue");
  const guard = stopProtection(position, orders);
  return (
    <article className="positionCard">
      <div className="positionCardHeader">{onOpen ? <OpenHolding position={position} book={book} t={t} onOpen={onOpen} /> : <AssetIdentity position={position} book={book} />}<span className="compactPnlStack"><span className={`compactPnl ${signedClass(positionPnl)}`}>{money(positionPnl, accountCurrency, locale, { signed: true })}</span><FxPart fx={resultSplit(position)?.fx} currency={accountCurrency} locale={locale} t={t} /></span></div>
      <div className="positionFacts">
        <div><span>{t("positionValue")}</span><strong><Lit moved={moved?.value} stamp={moved?.stamp ?? ""}>{money(positionValue, accountCurrency, locale)}</Lit></strong></div>
        <div><span>{t("currentPrice")}</span><strong><Lit moved={moved?.price} stamp={moved?.stamp ?? ""}>{money(position.currentPrice, position.instrument.currencyCode, locale)}</Lit></strong></div>
        <div><span>{t("quantity")}</span><strong>{qty(position.quantity, locale)}</strong></div>
        <div><span>{t("averagePrice")}</span><strong>{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</strong></div>
      </div>
      {day && (
        <div className="positionDay">
          <span>{t("todayColumn")}</span>
          <DayCell move={day.move} loading={day.loading} currency={accountCurrency} locale={locale} t={t} layout="card" />
        </div>
      )}
      {guard && (
        <div className={`positionGuard${guard.coverage < 1 ? " partial" : ""}`}>
          <span className="positionGuardMark" aria-hidden="true" />
          <span>{t("stopLoss")} <strong>{stopGuardText(guard, position, locale, t)}</strong></span>
          <small>{stopCoverageText(guard, position, locale, t)}</small>
        </div>
      )}
    </article>
  );
}

/**
 * When the dashboard was read, as "Just now" or "3 minutes ago" written again every half minute (the time itself in
 * its tooltip), marked once it may be out of date; with the switch that reads it again by itself and how that went.
 */
function UpdatedMetric({ timestamp, locale, t, auto }: { timestamp: string; locale: SupportedLocale; t: Translator; auto?: AutoRefreshState }) {
  const now = useNow();
  const age = ageText(timestamp, now, locale, t);
  const stopped = auto?.on && auto.failures >= MAX_FAILURES;
  const failed = auto?.on && auto.failures > 0 && !stopped ? fill(t("autoRefreshFailed"), { problem: auto.problem ?? "" }) : undefined;
  return (
    <div className={`metric compact updatedMetric${age.stale ? " stale" : ""}`}>
      <span>{t("lastUpdated")}</span>
      <strong>
        <time dateTime={timestamp} title={dateTime(timestamp, locale)}>{age.text}</time>
        {failed && <i className="refreshWarn" role="img" aria-label={failed} title={failed}>!</i>}
      </strong>
      {age.stale && <small className="staleNote">{t("updatedStale")}</small>}
      {auto && (
        <label className="toggleField autoRefreshToggle" title={t("autoRefreshHint")}>
          <input type="checkbox" checked={auto.on} onChange={(event) => auto.onChange(event.target.checked)} />
          <span className="toggleTrack"><span /></span><span>{t("autoRefresh")}</span>
        </label>
      )}
      {stopped && <small className="refreshStopped" role="status">{fill(t("autoRefreshStopped"), { count: num(MAX_FAILURES, locale), problem: auto.problem ?? "" })}</small>}
    </div>
  );
}

/** The recorded account value of the last 30 days: a small line and the change since the first day. */
function ValueTrend({ points, currency, locale, t }: { points: ValuePoint[]; currency: string; locale: SupportedLocale; t: Translator }) {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const change = last.totalValue - first.totalValue;
  // The window is at most 30 days, so the day and month are enough.
  const since = dayLabel(first.date, locale, { year: false });
  const changeText = `${money(change, currency, locale, { signed: true })}${first.totalValue ? ` (${pct(change / first.totalValue, locale, 1, { signed: true })})` : ""}`;
  return (
    <div className="valueTrend">
      <Sparkline points={points.map((point) => ({ time: Date.parse(`${point.date}T00:00:00Z`), value: point.totalValue }))}
        label={fill(t("valueTrendLabel"), { date: since, first: money(first.totalValue, currency, locale), last: money(last.totalValue, currency, locale) })} />
      <span><b className={signedClass(change)}>{changeText}</b> {fill(t("valueTrendSince"), { date: since })}</span>
    </div>
  );
}
