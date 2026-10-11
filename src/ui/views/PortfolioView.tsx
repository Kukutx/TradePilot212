import type { ActivityEvent, DashboardPayload, Position } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import { AssetIdentity, Metric, SectionHeader } from "../components/common";
import { money, qty, signedClass, time, walletNumber } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { activityLabel, activityNeedsAttention, countText, envLabel, type Translator } from "../lib/messages";
import { summarizeOrder } from "../lib/orders";

export function PortfolioView({
  payload,
  book,
  locale,
  t,
  writeEnabled,
  onCancel,
}: {
  payload: DashboardPayload;
  book?: InstrumentBook;
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
          <div className={`pnlBadge ${signedClass(pnl)}`}>{t("unrealizedPnL")} · {money(pnl, currency, locale, { signed: true })}</div>
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
                <thead><tr><th>{t("symbol")}</th><th>{t("quantity")}</th><th>{t("currentPrice")}</th><th className="optionalColumn">{t("averagePrice")}</th><th>{t("positionValue")}</th><th>{t("pnl")}</th><th className="optionalColumn">{t("availableToSell")}</th></tr></thead>
                <tbody>
                  {payload.positions.map((position) => {
                    const positionPnl = walletNumber(position, "unrealizedProfitLoss");
                    return (
                      <tr key={position.instrument.ticker}>
                        <td><AssetIdentity position={position} book={book} /></td>
                        <td>{qty(position.quantity, locale)}</td>
                        <td>{money(position.currentPrice, position.instrument.currencyCode, locale)}</td>
                        <td className="optionalColumn">{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</td>
                        <td>{money(walletNumber(position, "currentValue"), currency, locale)}</td>
                        <td className={signedClass(positionPnl)}>{money(positionPnl, currency, locale, { signed: true })}</td>
                        <td className="optionalColumn">{qty(position.quantityAvailableForTrading, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobilePositionList">
              {payload.positions.map((position) => (
                <PositionCard key={position.instrument.ticker} position={position} accountCurrency={currency} book={book} locale={locale} t={t} />
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
              const row = summarizeOrder(order, t, locale, payload.positions, book);
              const detail = [row.type, ...row.prices, row.detail, row.status].filter(Boolean).join(" · ");
              return (
                <div className="orderRow" key={id || index}>
                  <div className="orderIdentity" title={row.ticker}>
                    <strong>{row.name}</strong>
                    <span><b className={`orderSide ${row.side}`}>{row.side === "sell" ? t("sell") : t("buy")}</b> · {detail}</span>
                  </div>
                  <div className="orderQuantity">{qty(row.quantity, locale)}</div>
                  {writeEnabled && <button className="secondaryButton danger" type="button" data-focus-id={`cancel-${id}`} disabled={!id} onClick={() => id && onCancel(id)}>{t("prepareCancel")}</button>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ActivityPanel activity={payload.activity ?? []} book={book} locale={locale} t={t} />
    </main>
  );
}

export function ActivityPanel({ activity, book, locale, t }: { activity: ActivityEvent[]; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  return (
    <section className="dataPanel activityPanel">
      <details>
        <summary><span>{t("recentActivity")}</span><b>{activity.length}</b></summary>
        {activity.length === 0 ? <div className="emptyState compact">{t("noActivity")}</div> : (
          <div className="activityList">
            {activity.map((event) => (
              <div className="activityRow" key={event.id}>
                <span className={`activityDot ${activityNeedsAttention(event) ? "warning" : ""}`} aria-hidden="true" />
                <div>
                  <strong>{activityLabel(event, t)}</strong>
                  <small>{[event.ticker ? instrumentLabel(event.ticker, book).name : undefined, event.orderId, event.legs ? countText("orders", event.legs, t, locale) : undefined, event.planId].filter(Boolean).join(" · ") || envLabel(event.environment, t)}</small>
                </div>
                <time dateTime={event.timestamp}>{time(event.timestamp, locale)}</time>
              </div>
            ))}
          </div>
        )}
      </details>
    </section>
  );
}

export function PositionCard({
  position,
  accountCurrency,
  book,
  locale,
  t,
}: {
  position: Position;
  accountCurrency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
}) {
  const positionPnl = walletNumber(position, "unrealizedProfitLoss");
  const positionValue = walletNumber(position, "currentValue");
  return (
    <article className="positionCard">
      <div className="positionCardHeader"><AssetIdentity position={position} book={book} /><span className={`compactPnl ${signedClass(positionPnl)}`}>{money(positionPnl, accountCurrency, locale, { signed: true })}</span></div>
      <div className="positionFacts">
        <div><span>{t("positionValue")}</span><strong>{money(positionValue, accountCurrency, locale)}</strong></div>
        <div><span>{t("currentPrice")}</span><strong>{money(position.currentPrice, position.instrument.currencyCode, locale)}</strong></div>
        <div><span>{t("quantity")}</span><strong>{qty(position.quantity, locale)}</strong></div>
        <div><span>{t("averagePrice")}</span><strong>{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</strong></div>
      </div>
    </article>
  );
}
