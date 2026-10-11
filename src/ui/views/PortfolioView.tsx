import type { ActivityEvent, DashboardPayload, PendingOrder, Position } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import type { ValuePoint } from "../../shared/history";
import { stopProtection } from "../../shared/protection";
import { AssetIdentity, Metric, SectionHeader } from "../components/common";
import { Sparkline } from "../components/charts";
import { amount, dayLabel, money, num, pct, qty, signedClass, time, walletNumber } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { activityLabel, activityNeedsAttention, countText, envLabel, fill, type Translator } from "../lib/messages";
import { stopCoverageText, stopGuardText, summarizeOrder } from "../lib/orders";

export function PortfolioView({
  payload,
  book,
  locale,
  t,
  writeEnabled,
  onCancel,
  onOpen,
}: {
  payload: DashboardPayload;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onCancel: (orderId: string) => void;
  /** Opens one holding's detail. */
  onOpen?: (ticker: string) => void;
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
          <div className={`pnlBadge ${signedClass(pnl)}`}>{t("unrealizedPnL")} · {money(pnl, currency, locale, { signed: true })}</div>
          {payload.valueTrend && payload.valueTrend.length >= 2 && <ValueTrend points={payload.valueTrend} currency={currency} locale={locale} t={t} />}
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
                <thead><tr><th>{t("symbol")}</th><th>{t("quantity")}</th><th>{t("currentPrice")}</th><th className="optionalColumn">{t("averagePrice")}</th><th>{t("positionValue")}</th><th>{t("pnl")}</th><th className="optionalColumn">{t("availableToSell")}</th><th className="optionalColumn">{t("stopLoss")}</th></tr></thead>
                <tbody>
                  {payload.positions.map((position) => {
                    const positionPnl = walletNumber(position, "unrealizedProfitLoss");
                    const guard = stopProtection(position, payload.orders);
                    return (
                      <tr key={position.instrument.ticker}>
                        <td>
                          {onOpen ? <OpenHolding position={position} book={book} t={t} onOpen={onOpen} /> : <AssetIdentity position={position} book={book} />}
                          {/* Where the stop-loss column is hidden, the stop shows under the name. */}
                          {guard && <small className="stopInline">{t("stopLoss")} {stopGuardText(guard, position, locale, t)}{guard.coverage < 1 ? ` · ${stopCoverageText(guard, position, locale, t)}` : ""}</small>}
                        </td>
                        <td>{qty(position.quantity, locale)}</td>
                        <td>{money(position.currentPrice, position.instrument.currencyCode, locale)}</td>
                        <td className="optionalColumn">{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</td>
                        <td>{money(walletNumber(position, "currentValue"), currency, locale)}</td>
                        <td className={signedClass(positionPnl)}>{money(positionPnl, currency, locale, { signed: true })}</td>
                        <td className="optionalColumn">{qty(position.quantityAvailableForTrading, locale)}</td>
                        <td className="optionalColumn">{guard ? <span className="stopCell"><strong>{stopGuardText(guard, position, locale, t)}</strong><small>{stopCoverageText(guard, position, locale, t)}</small></span> : <span className="mutedInline" aria-label={t("noStopLoss")}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobilePositionList">
              {payload.positions.map((position) => (
                <PositionCard key={position.instrument.ticker} position={position} orders={payload.orders} accountCurrency={currency} book={book} locale={locale} t={t} {...(onOpen ? { onOpen } : {})} />
              ))}
            </div>
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
        const detail = [row.type, ...row.prices, row.detail, row.status].filter(Boolean).join(" · ");
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
}: {
  position: Position;
  /** Pending orders; a sell stop on this holding shows under its facts. */
  orders?: PendingOrder[];
  accountCurrency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onOpen?: (ticker: string) => void;
}) {
  const positionPnl = walletNumber(position, "unrealizedProfitLoss");
  const positionValue = walletNumber(position, "currentValue");
  const guard = stopProtection(position, orders);
  return (
    <article className="positionCard">
      <div className="positionCardHeader">{onOpen ? <OpenHolding position={position} book={book} t={t} onOpen={onOpen} /> : <AssetIdentity position={position} book={book} />}<span className={`compactPnl ${signedClass(positionPnl)}`}>{money(positionPnl, accountCurrency, locale, { signed: true })}</span></div>
      <div className="positionFacts">
        <div><span>{t("positionValue")}</span><strong>{money(positionValue, accountCurrency, locale)}</strong></div>
        <div><span>{t("currentPrice")}</span><strong>{money(position.currentPrice, position.instrument.currencyCode, locale)}</strong></div>
        <div><span>{t("quantity")}</span><strong>{qty(position.quantity, locale)}</strong></div>
        <div><span>{t("averagePrice")}</span><strong>{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</strong></div>
      </div>
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
