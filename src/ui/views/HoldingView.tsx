import type { PriceAlert } from "../../shared/automation";
import type { Position } from "../../shared/contracts";
import type { HoldingDetail, HoldingFill } from "../../shared/holding";
import type { SupportedLocale } from "../i18n";
import { Metric, SectionHeader } from "../components/common";
import { amount, dateTime, dayLabel, money, num, pct, qty, signedClass, time, walletNumber } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { alertConditionLabel, fill, instrumentTypeLabel, orderTypeLabel, type Translator } from "../lib/messages";
import { alertTarget } from "./AutomationView";
import { PendingOrderList } from "./PortfolioView";

export type PriceLevelKind = "last" | "average" | "stop" | "limit" | "alert";

export interface PriceLevel {
  key: string;
  kind: PriceLevelKind;
  price: number;
  label: string;
}

/** The price an armed alert fires at; percent alerts are worked out from the cost or the high-water mark. */
function alertPrice(alert: PriceAlert, position: Position | undefined): number | undefined {
  if (alert.condition === "above" || alert.condition === "below") return alert.price;
  if (alert.percent === undefined || !position) return undefined;
  const share = alert.percent / 100;
  if (alert.condition === "gain_percent") return position.averagePricePaid * (1 + share);
  if (alert.condition === "loss_percent") return position.averagePricePaid * (1 - share);
  return (alert.highWatermark ?? position.currentPrice) * (1 - share);
}

/** Where the last price, the average cost, open stops and limits and armed alerts sit, highest first. */
export function priceLevels(data: HoldingDetail, t: Translator, locale: SupportedLocale): PriceLevel[] {
  const position = data.position;
  const levels: PriceLevel[] = [];
  if (position && position.currentPrice > 0) levels.push({ key: "last", kind: "last", price: position.currentPrice, label: t("levelLast") });
  if (position && position.averagePricePaid > 0) levels.push({ key: "average", kind: "average", price: position.averagePricePaid, label: t("levelAverage") });
  data.orders.forEach((order, index) => {
    // A stop-limit is placed at its trigger; the limit applies once it fires.
    const trigger = typeof order.stopPrice === "number" ? order.stopPrice : typeof order.limitPrice === "number" ? order.limitPrice : undefined;
    if (trigger === undefined || !(trigger > 0)) return;
    const sell = String(order.side ?? "").toUpperCase() === "SELL" || (typeof order.quantity === "number" && order.quantity < 0);
    const label = fill(t("levelOrder"), {
      side: sell ? t("sell") : t("buy"),
      type: orderTypeLabel(typeof order.type === "string" ? order.type : undefined, t),
      quantity: typeof order.quantity === "number" ? qty(Math.abs(order.quantity), locale) : "",
    });
    levels.push({ key: `order-${order.id ?? index}`, kind: typeof order.stopPrice === "number" ? "stop" : "limit", price: trigger, label: label.replace(/ · $/, "") });
  });
  for (const alert of data.alerts) {
    if (alert.triggeredAt) continue;
    const price = alertPrice(alert, position);
    if (price === undefined || !(price > 0)) continue;
    const condition = alert.condition === "above" || alert.condition === "below" ? alertConditionLabel(alert.condition, t) : `${alertConditionLabel(alert.condition, t)} ${num(alert.percent, locale, 2)}%`;
    levels.push({ key: `alert-${alert.id}`, kind: "alert", price, label: fill(t("levelAlert"), { condition }) });
  }
  return levels.sort((a, b) => b.price - a.price);
}

function marketText(data: HoldingDetail, t: Translator, locale: SupportedLocale): string | undefined {
  const market = data.market;
  if (!market || market.session === "unknown") return undefined;
  if (market.isOpen) return market.nextClose ? fill(t("marketOpenUntil"), { time: time(market.nextClose, locale) }) : t("marketOpen");
  return market.nextOpen ? fill(t("marketOpensAt"), { time: dateTime(market.nextOpen, locale) }) : t("marketClosed");
}

export function HoldingView({
  data,
  book,
  locale,
  t,
  writeEnabled,
  onBack,
  onTrade,
  onCancel,
}: {
  data: HoldingDetail;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  onBack: () => void;
  onTrade: (side: "buy" | "sell") => void;
  onCancel: (orderId: string) => void;
}) {
  const position = data.position;
  const currency = data.accountCurrency ?? "EUR";
  const quote = data.instrument.currencyCode;
  const label = instrumentLabel(data.ticker, book, data.instrument);
  const value = position ? walletNumber(position, "currentValue") : undefined;
  const pnl = position ? walletNumber(position, "unrealizedProfitLoss") : undefined;
  const cost = value !== undefined && pnl !== undefined ? value - pnl : undefined;
  const levels = priceLevels(data, t, locale);
  const eyebrow = [data.instrument.type ? instrumentTypeLabel(data.instrument.type, t) : undefined, quote, marketText(data, t, locale)].filter(Boolean).join(" · ");
  const share = data.weight === undefined ? "—" : data.targetWeight === undefined ? pct(data.weight, locale) : `${pct(data.weight, locale)} / ${fill(t("targetShare"), { percent: pct(data.targetWeight, locale) })}`;
  return (
    <main className="contentStack">
      <nav className="holdingNav"><button type="button" className="linkButton" onClick={onBack}>‹ {t("backToHoldings")}</button></nav>

      <section className="overviewPanel holdingHero">
        <div className="overviewLead">
          {eyebrow && <span className="sectionEyebrow">{eyebrow}</span>}
          <h2 className="holdingName">{label.name}</h2>
          <span className="holdingMeta">{[label.detail || data.ticker, data.instrument.isin].filter(Boolean).join(" · ")}</span>
          {position ? (
            <>
              <strong className="heroValue small">{money(value, currency, locale)}</strong>
              <div className={`pnlBadge ${signedClass(pnl)}`}>
                {t("unrealizedPnL")} · {money(pnl, currency, locale, { signed: true })}{cost && pnl !== undefined ? ` (${pct(pnl / cost, locale, 1, { signed: true })})` : ""}
              </div>
            </>
          ) : <div className="pnlBadge">{t("notHeld")}</div>}
          {writeEnabled && (
            <div className="holdingActions">
              <button type="button" className="primaryButton" onClick={() => onTrade("buy")}>{t("buy")}</button>
              {position && position.quantityAvailableForTrading > 0 && <button type="button" className="secondaryButton" onClick={() => onTrade("sell")}>{t("sell")}</button>}
            </div>
          )}
        </div>
        {position && (
          <div className="metricGrid">
            <Metric label={t("quantity")} value={qty(position.quantity, locale)} />
            <Metric label={t("availableToSell")} value={qty(position.quantityAvailableForTrading, locale)} />
            <Metric label={t("currentPrice")} value={money(position.currentPrice, quote ?? currency, locale)} />
            <Metric label={t("averagePrice")} value={money(position.averagePricePaid, quote ?? currency, locale)} />
            <Metric label={t("accountShare")} value={share} />
            <Metric label={t("lastUpdated")} value={time(data.timestamp, locale)} compact />
          </div>
        )}
      </section>

      {levels.length >= 2 && <PriceLadder levels={levels} last={position?.currentPrice} currency={quote} locale={locale} t={t} />}

      <section className="dataPanel">
        <SectionHeader title={t("pendingOrders")} count={data.orders.length} />
        <PendingOrderList orders={data.orders} positions={position ? [position] : []} book={book} locale={locale} t={t} writeEnabled={writeEnabled} onCancel={onCancel} />
      </section>

      {data.alerts.length > 0 && (
        <section className="dataPanel">
          <SectionHeader title={t("alertsTitle")} count={data.alerts.length} />
          <ul className="automationList">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <div className="automationRow">
                  <strong>{alertConditionLabel(alert.condition, t)} {alertTarget(alert, book, locale)}</strong>
                  <span className={`statusPill ${alert.triggeredAt ? "fired" : ""}`}>{alert.triggeredAt ? t("alertTriggered") : t("alertArmed")}</span>
                </div>
                {alert.triggeredAt && <small>{dateTime(alert.triggeredAt, locale)} · {amount(alert.triggeredPrice, quote, locale)}</small>}
                {alert.note && <small className="mutedInline">{alert.note}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.history ? (
        <>
          <FillsPanel fills={data.history.fills} truncated={data.history.truncated} locale={locale} t={t} />
          <section className="dataPanel">
            <div className="pieHeader">
              <h2>{t("holdingDividendsTitle")}</h2>
              {data.history.dividendCount > 0 && <span className="panelTotal">{fill(t("holdingDividendsTotal"), { total: money(data.history.dividendTotal, currency, locale) })}</span>}
            </div>
            {data.history.dividends.length === 0 ? <div className="emptyState compact">{t("holdingNoDividends")}</div> : (
              <ul className="historyList">
                {data.history.dividends.map((item, index) => (
                  <li key={`${item.date}-${index}`}>
                    <div><strong>{dayLabel(item.date, locale)}</strong>{item.grossPerShare !== undefined && <small>{fill(t("holdingPerShare"), { amount: amount(item.grossPerShare, item.perShareCurrency || quote, locale) })}{item.quantity !== undefined ? ` · ${qty(item.quantity, locale)}` : ""}</small>}</div>
                    <strong className="positive">{money(item.amount, item.currency || currency, locale, { signed: true })}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <div className="notice warning"><strong>{t("holdingHistoryMissing")}</strong><span>{data.historyProblem}</span></div>
      )}
    </main>
  );
}

/** The price levels as a ladder, highest at the top, each with its distance from the last price. */
function PriceLadder({ levels, last, currency, locale, t }: { levels: PriceLevel[]; last?: number; currency?: string; locale: SupportedLocale; t: Translator }) {
  return (
    <section className="dataPanel">
      <div className="pieHeader"><h2>{t("priceLevels")}</h2></div>
      <ol className="levelLadder">
        {levels.map((level) => {
          const gap = last && level.kind !== "last" ? (level.price - last) / last : undefined;
          return (
            <li key={level.key} className={`levelRow ${level.kind}`}>
              <span className="levelMark" aria-hidden="true" />
              <span className="levelLabel">{level.label}</span>
              <span className="levelPrice">{amount(level.price, currency, locale)}</span>
              <span className="levelGap">{gap === undefined ? "" : pct(gap, locale, 1, { signed: true })}</span>
            </li>
          );
        })}
      </ol>
      {last !== undefined && <p className="panelNote">{t("priceLevelsNote")}</p>}
    </section>
  );
}

function FillsPanel({ fills, truncated, locale, t }: { fills: HoldingFill[]; truncated: boolean; locale: SupportedLocale; t: Translator }) {
  return (
    <section className="dataPanel">
      <SectionHeader title={t("holdingFillsTitle")} count={fills.length} />
      {fills.length === 0 ? <div className="emptyState compact">{t("holdingNoFills")}</div> : (
        <ul className="historyList">
          {fills.map((item, index) => {
            const sell = String(item.side ?? "").toUpperCase() === "SELL" || (item.quantity ?? 0) < 0;
            return (
              <li key={`${item.filledAt}-${index}`}>
                <div>
                  <strong><b className={`orderSide ${sell ? "sell" : "buy"}`}>{sell ? t("sell") : t("buy")}</b> {qty(Math.abs(item.quantity ?? 0), locale)} · {amount(item.price, item.priceCurrency, locale)}</strong>
                  <small>{item.filledAt ? dayLabel(item.filledAt, locale) : "—"}{item.type ? ` · ${orderTypeLabel(item.type, t)}` : ""}</small>
                </div>
                <div className="historyAmount">
                  <strong>{item.netValue === undefined ? "—" : money(item.netValue, item.accountCurrency ?? "EUR", locale)}</strong>
                  {item.realisedProfitLoss ? <small className={signedClass(item.realisedProfitLoss)}>{fill(t("holdingRealized"), { amount: money(item.realisedProfitLoss, item.accountCurrency ?? "EUR", locale, { signed: true }) })}</small> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="panelNote">{t("holdingHistoryTruncated")}</p>}
    </section>
  );
}
