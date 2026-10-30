import { useState, type ReactNode } from "react";
import type { PriceAlert } from "../../shared/automation";
import type { Position } from "../../shared/contracts";
import type { HoldingDetail, HoldingFill } from "../../shared/holding";
import type { JournalEntry } from "../../shared/journal";
import { stopOutcome, stopProtection, suggestedStop } from "../../shared/protection";
import { resultSplit } from "../../shared/result-split";
import type { SupportedLocale } from "../i18n";
import { AlertActions, AlertForm, type AlertRequest } from "../components/alerts";
import { Metric, SectionHeader } from "../components/common";
import { DayLine } from "../components/day";
import { JournalForm, JournalNote, type JournalRequest } from "../components/journal";
import { PositionChart } from "../components/position-chart";
import { PriceChart, type ChartLevel, type ChartTrade } from "../components/price-chart";
import { fxShown, ResultSplitBars } from "../components/result-split";
import { holdingPositionHistory } from "../../shared/position-history";
import type { PricesMissing } from "../../shared/prices";
import type { MessageKey } from "../i18n";
import { amount, dateTime, dayLabel, money, num, pct, qty, signedClass, time, walletNumber } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { alertConditionLabel, fill, instrumentTypeLabel, orderTypeLabel, quoteProviderLabel, type Translator } from "../lib/messages";
import { alertTarget } from "./AutomationView";
import { stopCoverageText, stopGuardText } from "../lib/orders";
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
  // Not held, the quote provider's price stands in for Trading 212's.
  const last = position && position.currentPrice > 0 ? position.currentPrice : data.quote?.price;
  if (last && last > 0) levels.push({ key: "last", kind: "last", price: last, label: t("levelLast") });
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
    // A day's move fires either way from the previous close: two levels.
    const close = data.day?.previousClose?.close;
    if (alert.condition === "day_move") {
      if (!close || alert.percent === undefined) continue;
      for (const sign of [1, -1]) {
        const price = close * (1 + (sign * alert.percent) / 100);
        if (price > 0) levels.push({ key: `alert-${alert.id}-${sign > 0 ? "up" : "down"}`, kind: "alert", price, label: fill(t("levelDayMove"), { change: `${sign > 0 ? "+" : "-"}${num(alert.percent, locale, 2)}%` }) });
      }
      continue;
    }
    const price = alertPrice(alert, position);
    if (price === undefined || !(price > 0)) continue;
    const condition = alert.condition === "above" || alert.condition === "below" ? alertConditionLabel(alert.condition, t) : `${alertConditionLabel(alert.condition, t)} ${num(alert.percent, locale, 2)}%`;
    levels.push({ key: `alert-${alert.id}`, kind: "alert", price, label: fill(t("levelAlert"), { condition }) });
  }
  return levels.sort((a, b) => b.price - a.price);
}

export const MISSING_KEYS: Record<PricesMissing, MessageKey> = {
  provider: "pricesMissingProvider",
  plan: "pricesMissingPlan",
  symbol: "pricesMissingSymbol",
  data: "pricesMissingData",
  unit: "pricesMissingUnit",
  sample: "pricesMissingSample",
};

/** The fills as chart markers, each saying what was traded at what price. */
export function chartTrades(fills: HoldingFill[], currency: string | undefined, t: Translator, locale: SupportedLocale): ChartTrade[] {
  return fills.flatMap((item, index) => {
    const time = item.filledAt ? Date.parse(item.filledAt) : Number.NaN;
    if (!Number.isFinite(time) || !item.price || !(item.price > 0)) return [];
    const sell = String(item.side ?? "").toUpperCase() === "SELL" || (item.quantity ?? 0) < 0;
    const text = fill(t(sell ? "priceSold" : "priceBought"), { quantity: qty(Math.abs(item.quantity ?? 0), locale), price: amount(item.price, item.priceCurrency ?? currency, locale) });
    return [{ key: `${item.orderId ?? "fill"}-${index}`, time, price: item.price, side: sell ? "sell" as const : "buy" as const, text }];
  });
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
  busy,
  backLabel,
  onBack,
  onTrade,
  onProtect,
  onCancel,
  onSaveAlert,
  onDeleteAlert,
  onRearmAlert,
  onSaveNote,
  onDeleteNote,
  onWatch,
}: {
  data: HoldingDetail;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  writeEnabled: boolean;
  /** While a read or write is running, Back and the alert controls wait, so a late result can't replace the page. */
  busy: boolean;
  /** Where Back goes, when not the holdings list: the view the page was opened from. */
  backLabel?: string;
  onBack: () => void;
  onTrade: (side: "buy" | "sell") => void;
  /** Opens the order editor with a sell stop for the uncovered shares; nothing is sent until reviewed and confirmed. */
  onProtect?: (stop: { quantity: number; stopPrice: number }) => void;
  onCancel: (orderId: string) => void;
  /** Resolves true once the alert is saved, so the form can close. */
  onSaveAlert: (request: AlertRequest) => Promise<boolean>;
  onDeleteAlert: (alertId: string) => void;
  onRearmAlert: (alertId: string) => void;
  /** Adds a note (on a fill's order when `orderId` is given) or changes one; resolves true once saved. */
  onSaveNote: (request: JournalRequest & { entryId?: string; orderId?: string }) => Promise<boolean>;
  onDeleteNote: (entryId: string) => void;
  /** Puts the instrument on the watchlist, or takes it off; the watchlist never trades. */
  onWatch?: (watch: boolean) => void;
}) {
  const [addingAlert, setAddingAlert] = useState(false);
  // The open journal form: a change to a note, a new note on a fill's order, or (neither) a new note.
  const [noteForm, setNoteForm] = useState<{ entryId?: string; orderId?: string; focus?: "review" } | null>(null);
  const journal = data.journal ?? [];
  const fills = data.history?.fills ?? [];
  // A fill shows the note on its order; the newest note wins when there are several.
  const notes = new Map<string, JournalEntry>();
  for (const entry of journal) if (entry.orderId && !notes.has(entry.orderId)) notes.set(entry.orderId, entry);
  const saveNote = (request: JournalRequest) => {
    const form = noteForm;
    if (!form) return;
    void onSaveNote({ ...request, ...(form.entryId ? { entryId: form.entryId } : {}), ...(form.orderId ? { orderId: form.orderId } : {}) })
      .then((saved) => { if (saved) setNoteForm(null); });
  };
  const addingNote = noteForm !== null && !noteForm.entryId && !noteForm.orderId;
  const position = data.position;
  const currency = data.accountCurrency ?? "EUR";
  const positionHistory = holdingPositionHistory(data);
  const quote = data.instrument.currencyCode;
  const label = instrumentLabel(data.ticker, book, data.instrument);
  const value = position ? walletNumber(position, "currentValue") : undefined;
  const pnl = position ? walletNumber(position, "unrealizedProfitLoss") : undefined;
  const cost = value !== undefined && pnl !== undefined ? value - pnl : undefined;
  const split = position ? resultSplit(position) : undefined;
  const levels = priceLevels(data, t, locale);
  // The price now: Trading 212's for a holding, else the quote provider's when it answered.
  const lastPrice = position?.currentPrice || data.quote?.price;
  const guard = position ? stopProtection(position, data.orders) : undefined;
  // For a holding, say whether a sell stop protects it; an unheld instrument has nothing to protect.
  const guardNote = !position ? undefined : guard
    ? `${t("stopLoss")} ${stopGuardText(guard, position, locale, t)} · ${stopCoverageText(guard, position, locale, t)}`
    : t("noStopLoss");
  // What reaching the stops would cost from here, each at the price it names; a gap can fill one lower.
  const outcome = position && guard ? stopOutcome(position, guard) : undefined;
  // Distinct stop prices: two stop-limits at one stop trigger together.
  const several = new Set(guard?.levels.map((level) => level.stopPrice)).size > 1;
  const guardDetail = outcome
    ? fill(t(several ? (outcome.pnlAtStop === undefined ? "stopsOutcomeShort" : "stopsOutcome") : (outcome.pnlAtStop === undefined ? "stopOutcomeShort" : "stopOutcome")), { change: money(-outcome.drop, currency, locale, { signed: true }), pnl: money(outcome.pnlAtStop, currency, locale, { signed: true }) })
      + (guard?.levels.some((level) => level.limitPrice !== undefined) ? ` ${t("stopLimitOutcome")}` : "")
    : undefined;
  const stop = position && writeEnabled && onProtect ? suggestedStop(position, guard) : undefined;
  const protect = stop && onProtect
    ? <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => onProtect(stop)}>{guard ? t("addStopForRest") : t("addStopLoss")}</button>
    : undefined;
  const eyebrow = [data.instrument.type ? instrumentTypeLabel(data.instrument.type, t) : undefined, quote, marketText(data, t, locale)].filter(Boolean).join(" · ");
  const share = data.weight === undefined ? "—" : data.targetWeight === undefined ? pct(data.weight, locale) : `${pct(data.weight, locale)} / ${fill(t("targetShare"), { percent: pct(data.targetWeight, locale) })}`;
  return (
    <main className="contentStack">
      <nav className="holdingNav">
        <button type="button" className="linkButton" disabled={busy} onClick={onBack}>‹ {backLabel ?? t("backToHoldings")}</button>
        {onWatch && (
          <button type="button" className={`watchToggle${data.watching ? " on" : ""}`} aria-pressed={Boolean(data.watching)} disabled={busy}
            title={t("watchToggleLabel")} onClick={() => onWatch(!data.watching)}>
            <span aria-hidden="true">{data.watching ? "★" : "☆"}</span>{data.watching ? t("watchToggleOn") : t("watchToggleAdd")}
          </button>
        )}
      </nav>

      <section className="overviewPanel holdingHero">
        <div className="overviewLead">
          {eyebrow && <span className="sectionEyebrow">{eyebrow}</span>}
          <h2 className="holdingName">{label.name}</h2>
          <span className="holdingMeta">{[label.detail || data.ticker, data.instrument.isin].filter(Boolean).join(" · ")}</span>
          {data.watching && <small className="watchingNote">{fill(t("watchingSince"), { date: dayLabel(data.watching.addedAt, locale) })}{data.watching.note ? ` · ${data.watching.note}` : ""}</small>}
          {position ? (
            <>
              <strong className="heroValue small">{money(value, currency, locale)}</strong>
              <div className={`pnlBadge ${signedClass(pnl)}`}>
                {t("unrealizedPnL")} · {money(pnl, currency, locale, { signed: true })}{cost && pnl !== undefined ? ` (${pct(pnl / cost, locale, 1, { signed: true })})` : ""}
              </div>
              {split && fxShown(split.fx) && <ResultSplitBars price={split.price} fx={split.fx} currency={currency} locale={locale} t={t} />}
              {data.day && <DayLine move={data.day} timestamp={data.timestamp} currency={currency} locale={locale} t={t} />}
            </>
          ) : (
            <>
              {data.quote && <strong className="heroValue small">{amount(data.quote.price, quote, locale)}</strong>}
              {data.day && ((data.quote && data.day.change !== undefined) || data.day.profitLoss !== undefined) && <DayLine move={data.day} timestamp={data.timestamp} currency={currency} locale={locale} t={t} />}
              <div className="pnlBadge">{t("notHeld")}{data.targetWeight === undefined ? "" : ` · ${fill(t("targetShare"), { percent: pct(data.targetWeight, locale) })}`}</div>
              {data.quote && <small className="quoteNote">{data.quote.source === "sample" ? t("quoteFromSample") : fill(t("quoteFrom"), { source: quoteProviderLabel(data.quote.source, t), symbol: data.quote.symbol, time: dateTime(data.quote.asOf, locale) })}</small>}
            </>
          )}
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

      {data.prices && data.prices.points.length >= 2 ? (
        <section className="dataPanel">
          <PriceChart prices={data.prices} trades={chartTrades([...fills, ...(data.history?.olderFills ?? [])], quote, t, locale)} levels={levels.filter((level): level is PriceLevel & ChartLevel => level.kind !== "last")}
            {...(quote ? { currency: quote } : {})} locale={locale} t={t} />
        </section>
      ) : data.pricesMissing && (
        <section className="dataPanel">
          <div className="pieHeader"><h2>{t("priceChartTitle")}</h2></div>
          <div className="emptyState compact">{t(MISSING_KEYS[data.pricesMissing])}</div>
          {/* The provider's own words (a limit, a plan, the factor to map) for the cases only it can explain. */}
          {(data.pricesMissing === "data" || data.pricesMissing === "unit") && data.pricesProblem && <p className="panelNote">{data.pricesProblem}</p>}
        </section>
      )}

      {positionHistory && (typeof positionHistory === "object" ? (
        <section className="dataPanel"><PositionChart history={positionHistory} currency={currency} {...(quote ? { quoteCurrency: quote } : {})} locale={locale} t={t} /></section>
      ) : (
        <section className="dataPanel">
          <div className="pieHeader"><h2>{t("positionTitle")}</h2></div>
          <p className="panelNote">{t(positionHistory === "quantity" ? "positionQuantity" : positionHistory === "split" ? "positionSplit" : "positionFills")}</p>
        </section>
      ))}

      {/* The protection line shows even when a missing price leaves too few levels for a ladder. */}
      {(levels.length >= 2 || guardNote) && <PriceLadder levels={levels} {...(lastPrice ? { last: lastPrice } : {})} currency={quote} locale={locale} t={t} {...(guardNote ? { guardNote, partial: !guard || guard.coverage < 1 } : {})} {...(guardDetail ? { guardDetail } : {})} {...(protect ? { action: protect } : {})} />}

      <section className="dataPanel">
        <SectionHeader title={t("pendingOrders")} count={data.orders.length} />
        <PendingOrderList orders={data.orders} positions={position ? [position] : []} book={book} locale={locale} t={t} writeEnabled={writeEnabled} onCancel={onCancel} />
      </section>

      <section className="dataPanel">
        <div className="pieHeader">
          <h2>{t("alertsTitle")}</h2>
          {!addingAlert && <button type="button" className="secondaryButton compactButton" onClick={() => setAddingAlert(true)}>{t("addAlert")}</button>}
        </div>
        {addingAlert && (
          <AlertForm held={Boolean(position)} {...(lastPrice ? { last: lastPrice } : {})} {...(quote ? { currency: quote } : {})} locale={locale} t={t} busy={busy}
            onCancel={() => setAddingAlert(false)}
            onSave={(request) => void onSaveAlert(request).then((saved) => { if (saved) setAddingAlert(false); })} />
        )}
        {data.alerts.length === 0 ? (!addingAlert && <div className="emptyState compact">{t("noAlerts")}</div>) : (
          <ul className="automationList">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <div className="automationRow">
                  <strong>{alertConditionLabel(alert.condition, t)} {alertTarget(alert, book, locale)}</strong>
                  <span className={`statusPill ${alert.triggeredAt ? "fired" : ""}`}>{alert.triggeredAt ? t("alertTriggered") : t("alertArmed")}</span>
                </div>
                {alert.triggeredAt && <small>{dateTime(alert.triggeredAt, locale)} · {amount(alert.triggeredPrice, quote, locale)}{alert.condition === "day_move" ? ` · ${t("alertDayAgain")}` : ""}</small>}
                {alert.note && <small className="mutedInline">{alert.note}</small>}
                <AlertActions alert={alert} t={t} busy={busy} onRearm={onRearmAlert} onDelete={onDeleteAlert} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dataPanel">
        <div className="pieHeader">
          <h2>{t("journalTitle")}</h2>
          {!addingNote && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => setNoteForm({})}>{t("journalAdd")}</button>}
        </div>
        {addingNote && <JournalForm t={t} busy={busy} onCancel={() => setNoteForm(null)} onSave={saveNote} />}
        {journal.length === 0 ? (!addingNote && <div className="emptyState compact">{t("journalEmpty")}</div>) : (
          <ul className="journalList">
            {journal.map((entry) => noteForm?.entryId === entry.id ? (
              <li key={entry.id} className="journalNote editing">
                <JournalForm entry={entry} {...(noteForm.focus ? { focus: noteForm.focus } : {})} t={t} busy={busy} onCancel={() => setNoteForm(null)} onSave={saveNote} />
              </li>
            ) : (
              <JournalNote key={entry.id} entry={entry} fills={fills} locale={locale} t={t} busy={busy}
                onEdit={(focus) => setNoteForm({ entryId: entry.id, ...(focus ? { focus } : {}) })}
                onDelete={() => onDeleteNote(entry.id)} />
            ))}
          </ul>
        )}
        {data.journalTotal !== undefined && data.journalTotal > journal.length && <p className="panelNote">{fill(t("journalMore"), { shown: String(journal.length), total: String(data.journalTotal) })}</p>}
      </section>

      {data.history ? (
        <>
          <FillsPanel fills={data.history.fills} truncated={data.history.fillsTruncated} notes={notes} locale={locale} t={t} busy={busy}
            formFor={noteForm?.orderId && !noteForm.entryId ? noteForm.orderId : undefined}
            onAddNote={(orderId) => setNoteForm({ orderId })}
            form={<JournalForm t={t} busy={busy} onCancel={() => setNoteForm(null)} onSave={saveNote} />} />
          <section className="dataPanel">
            <div className="pieHeader">
              <h2>{fill(t("holdingDividendsTitle"), { date: dayLabel(data.history.dividendsFrom ?? data.history.from, locale) })}</h2>
              {data.history.dividendCount > 0 && <span className="panelTotal">{fill(t("holdingDividendsTotal"), { total: money(data.history.dividendTotal, currency, locale) })}</span>}
            </div>
            {data.history.nextDividends && <NextDividends payments={data.history.nextDividends} frequency={data.history.dividendFrequency} today={data.timestamp} currency={currency} locale={locale} t={t} />}
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
            {data.history.dividendsTruncated && <p className="panelNote">{t("holdingDividendsTruncated")}</p>}
          </section>
        </>
      ) : (
        <div className="notice warning"><strong>{t("holdingHistoryMissing")}</strong><span>{data.historyProblem}</span></div>
      )}
    </main>
  );
}

/** The price levels as a ladder, highest at the top, each with its distance from the last price. */
function PriceLadder({ levels, last, currency, locale, t, guardNote, guardDetail, partial, action }: { levels: PriceLevel[]; last?: number; currency?: string; locale: SupportedLocale; t: Translator; guardNote?: string; guardDetail?: string; partial?: boolean; action?: ReactNode }) {
  return (
    <section className="dataPanel">
      <div className="pieHeader"><h2>{t("priceLevels")}</h2></div>
      {guardNote && <div className={`ladderGuard${partial ? " partial" : ""}`}><span className="guardText"><span className="positionGuardMark" aria-hidden="true" />{guardNote}{guardDetail && <small className="guardDetail">{guardDetail}</small>}</span>{action}</div>}
      {levels.length >= 2 && <ol className="levelLadder">
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
      </ol>}
      {levels.length >= 2 && last !== undefined && <p className="panelNote">{t("priceLevelsNote")}</p>}
    </section>
  );
}

/**
 * The fills, each with the journal note on its order, or a link to write one. `formFor` names the order whose
 * new note is being written; the form shows under that order's newest fill.
 */
function FillsPanel({ fills, truncated, notes, locale, t, busy, formFor, form, onAddNote }: {
  fills: HoldingFill[];
  truncated: boolean;
  notes: Map<string, JournalEntry>;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  formFor?: string | undefined;
  form: ReactNode;
  onAddNote: (orderId: string) => void;
}) {
  const formAt = formFor ? fills.findIndex((item) => item.orderId === formFor) : -1;
  return (
    <section className="dataPanel">
      <SectionHeader title={t("holdingFillsTitle")} count={fills.length} />
      {fills.length === 0 ? <div className="emptyState compact">{t("holdingNoFills")}</div> : (
        <ul className="historyList">
          {fills.map((item, index) => {
            const sell = String(item.side ?? "").toUpperCase() === "SELL" || (item.quantity ?? 0) < 0;
            const note = item.orderId ? notes.get(item.orderId) : undefined;
            const writing = index === formAt;
            const text = note?.thesis ?? note?.review;
            return (
              <li key={`${item.filledAt}-${index}`} className={note || writing ? "withNote" : undefined}>
                <div>
                  <strong><b className={`orderSide ${sell ? "sell" : "buy"}`}>{sell ? t("sell") : t("buy")}</b> {qty(Math.abs(item.quantity ?? 0), locale)} · {amount(item.price, item.priceCurrency, locale)}</strong>
                  <small>
                    {item.filledAt ? dayLabel(item.filledAt, locale) : "—"}{item.type ? ` · ${orderTypeLabel(item.type, t)}` : ""}
                    {!note && !writing && item.orderId && <>{" · "}<button type="button" className="inlineLink" disabled={busy} aria-label={`${t("journalAdd")}: ${sell ? t("sell") : t("buy")} ${qty(Math.abs(item.quantity ?? 0), locale)}${item.filledAt ? `, ${dayLabel(item.filledAt, locale)}` : ""}`} onClick={() => onAddNote(item.orderId!)}>{t("journalAdd")}</button></>}
                  </small>
                </div>
                <div className="historyAmount">
                  <strong>{item.netValue === undefined ? "—" : money(item.netValue, item.accountCurrency ?? "EUR", locale)}</strong>
                  {item.realisedProfitLoss ? <small className={signedClass(item.realisedProfitLoss)}>{fill(t("holdingRealized"), { amount: money(item.realisedProfitLoss, item.accountCurrency ?? "EUR", locale, { signed: true }) })}</small> : null}
                </div>
                {note && text && <p className="fillNote" title={text}><span>{t(note.thesis ? "journalWhy" : "journalReview")}</span>{text}</p>}
                {writing && <div className="fillNoteForm">{form}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="panelNote">{t("holdingHistoryTruncated")}</p>}
    </section>
  );
}

const FREQUENCY: Record<52 | 26 | 12 | 4 | 2 | 1, MessageKey> = {
  52: "dividendWeekly", 26: "dividendFortnightly", 12: "dividendMonthly", 4: "dividendQuarterly", 2: "dividendHalfYearly", 1: "dividendYearly",
};

/** The holding's expected payments over the next 12 months, the soonest four, apart from the ones it paid. */
function NextDividends({ payments, frequency, today, currency, locale, t }: {
  payments: Array<{ on: string; amount: number }>;
  frequency: 52 | 26 | 12 | 4 | 2 | 1 | undefined;
  today: string;
  currency: string;
  locale: SupportedLocale;
  t: Translator;
}) {
  const day = today.slice(0, 10);
  return (
    <div className="nextDividends">
      <h3>{t("holdingNextDividends")}{frequency && <small className="headingDetail"> · {t(FREQUENCY[frequency])}</small>}</h3>
      <ul className="historyList">
        {payments.slice(0, 4).map((payment) => (
          <li key={payment.on}>
            <div><strong>{fill(t(payment.on < day ? "dividendDue" : "dividendAbout"), { date: dayLabel(payment.on, locale, { year: payment.on.slice(0, 4) !== day.slice(0, 4) }) })}</strong></div>
            <strong className="historyAmount expectedAmount">{fill(t("aboutAmount"), { amount: money(payment.amount, currency, locale) })}</strong>
          </li>
        ))}
      </ul>
      <p className="panelNote">{t("holdingNextNote")}</p>
    </div>
  );
}
