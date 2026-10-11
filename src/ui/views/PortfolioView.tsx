import type { ActivityEvent, DashboardPayload, PendingOrder, Position } from "../../shared/contracts";
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
                <thead><tr><th>{t("symbol")}</th><th>{t("quantity")}</th><th>{t("currentPrice")}</th><th className="optionalColumn">{t("averagePrice")}</th><th>{t("positionValue")}</th><th>{t("pnl")}</th><th className="optionalColumn">{t("availableToSell")}</th></tr></thead>
                <tbody>
                  {payload.positions.map((position) => {
                    const positionPnl = walletNumber(position, "unrealizedProfitLoss");
                    return (
                      <tr key={position.instrument.ticker}>
                        <td><AssetIdentity position={position} /></td>
                        <td>{num(position.quantity, locale)}</td>
                        <td>{money(position.currentPrice, position.instrument.currencyCode, locale)}</td>
                        <td className="optionalColumn">{money(position.averagePricePaid, position.instrument.currencyCode, locale)}</td>
                        <td>{money(walletNumber(position, "currentValue"), currency, locale)}</td>
                        <td className={signedClass(positionPnl)}>{money(positionPnl, currency, locale)}</td>
                        <td className="optionalColumn">{num(position.quantityAvailableForTrading, locale)}</td>
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
              const row = describeOrder(order, payload.positions, t, locale);
              return (
                <div className="orderRow" key={id || index}>
                  <div className="orderIdentity">
                    <strong>{row.name}</strong>
                    <span><b className={`orderSide ${row.side}`}>{row.side === "sell" ? t("sell") : t("buy")}</b> · {row.detail}</span>
                  </div>
                  <div className="orderQuantity">{num(row.quantity, locale)}</div>
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

const ORDER_TYPES: Record<string, "market" | "limit" | "stop" | "stopLimit"> = { MARKET: "market", LIMIT: "limit", STOP: "stop", STOP_LIMIT: "stopLimit" };

/** A pending order as people read it: the instrument's name, the side, the order type with its prices, and the status. */
function describeOrder(order: PendingOrder, positions: Position[], t: Translator, locale: SupportedLocale) {
  const ticker = typeof order.ticker === "string" ? order.ticker : "";
  const held = positions.find((position) => position.instrument.ticker === ticker)?.instrument;
  const embedded = order.instrument as { name?: unknown; currencyCode?: unknown; currency?: unknown } | undefined;
  // Trading 212 tickers end in a venue suffix: AAPL_US_EQ, VUSAl_EQ (London), SAPd_EQ (Xetra).
  const symbol = ticker.replace(/_US_EQ$/, "").replace(/[a-z]?_EQ$/, "");
  const name = held?.name || (typeof embedded?.name === "string" ? embedded.name : "") || symbol || ticker || "—";
  const currency = held?.currencyCode
    || (typeof embedded?.currencyCode === "string" ? embedded.currencyCode : "")
    || (typeof embedded?.currency === "string" ? embedded.currency : "")
    || (typeof order.currency === "string" ? order.currency : "")
    || (ticker.endsWith("_US_EQ") ? "USD" : "");
  const quantity = typeof order.quantity === "number" ? order.quantity : undefined;
  const side = String(order.side ?? "").toUpperCase() === "SELL" || (quantity ?? 0) < 0 ? "sell" : "buy";
  const typeKey = ORDER_TYPES[String(order.type ?? "").toUpperCase()];
  const price = (value: unknown) => (typeof value === "number" ? (currency ? money(value, currency, locale) : num(value, locale)) : undefined);
  const stop = price(order.stopPrice);
  const limit = price(order.limitPrice);
  // A plain Limit or Stop order reads "Limit $215"; a Stop-Limit names both prices.
  const type = [typeKey ? t(typeKey) : String(order.type ?? ""), stop && limit ? "" : stop ?? limit ?? ""].filter(Boolean).join(" ");
  const prices = stop && limit ? [`${t("stopPrice")} ${stop}`, `${t("limitPrice")} ${limit}`] : [];
  const detail = [type, ...prices, name !== ticker ? ticker : undefined, typeof order.status === "string" ? order.status : undefined]
    .filter(Boolean)
    .join(" · ");
  return { name, side, detail, quantity: quantity === undefined ? undefined : Math.abs(quantity) } as const;
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
