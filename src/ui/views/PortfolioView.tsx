import type { ActivityEvent, DashboardPayload, Position } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import { AssetIdentity, Metric, SectionHeader } from "../components/common";
import { money, num, signedClass, time, walletNumber } from "../lib/format";
import { activityLabel, type Translator } from "../lib/messages";

export function PortfolioView({
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

      <ActivityPanel activity={payload.activity ?? []} locale={locale} t={t} />
    </main>
  );
}

export function ActivityPanel({ activity, locale, t }: { activity: ActivityEvent[]; locale: SupportedLocale; t: Translator }) {
  return (
    <section className="dataPanel activityPanel">
      <details>
        <summary><span>{t("recentActivity")}</span><b>{activity.length}</b></summary>
        {activity.length === 0 ? <div className="emptyState compact">{t("noActivity")}</div> : (
          <div className="activityList">
            {activity.map((event) => (
              <div className="activityRow" key={event.id}>
                <span className={`activityDot ${event.type.includes("unknown") || event.type.includes("rejected") || event.type === "plan_skipped" ? "warning" : ""}`} />
                <div><strong>{activityLabel(event, t)}</strong><small>{[event.ticker, event.orderId, event.legs ? `${event.legs} ${t("activityLegs")}` : undefined, event.planId].filter(Boolean).join(" · ") || event.environment.toUpperCase()}</small></div>
                <time>{time(event.timestamp, locale)}</time>
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
