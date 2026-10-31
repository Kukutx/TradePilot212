import type { OrderStatusReport, PendingOrder, TradingEnvironment } from "../../shared/contracts";
import type { ExportReport, ExportSummary, ExportTotals } from "../../shared/history";
import { localeTag, type MessageKey, type SupportedLocale } from "../i18n";
import { AssetAvatar, DetailRow, Metric } from "../components/common";
import { amount, dateTime, dayLabel, money, pct, qty, signedClass } from "../lib/format";
import { instrumentCurrency, instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, orderTypeLabel, plural, type Translator } from "../lib/messages";
import { changeBlock } from "../lib/orders";

// Pages for tools whose result is one thing to look at: an order looked up by id, and Trading 212's CSV reports.

const STATE_KEYS: Record<OrderStatusReport["state"], MessageKey> = {
  open: "orderStatusOpen",
  partly_filled: "orderStatusPartial",
  filled: "orderStatusFilled",
  cancelled: "orderStatusCancelled",
  rejected: "orderStatusRejected",
  closed: "orderStateClosed",
  not_found: "orderStateNotFound",
};
const STATE_TONES: Record<OrderStatusReport["state"], string> = {
  open: "", partly_filled: "fired", filled: "auto", cancelled: "ended", rejected: "ended", closed: "ended", not_found: "ended",
};

/** "Limit $215.00", or a Stop-Limit with both of its prices named. */
function orderTerms(order: OrderStatusReport["order"], currency: string | undefined, t: Translator, locale: SupportedLocale): string {
  const type = orderTypeLabel(String(order?.type ?? ""), t);
  const price = (value: unknown) => (typeof value === "number" ? amount(value, currency, locale, { digits: 4 }) : undefined);
  const limit = price(order?.limitPrice), stop = price(order?.stopPrice);
  if (limit && stop) return [type, `${t("stopPrice")} ${stop}`, `${t("limitPrice")} ${limit}`].join(" · ");
  return [type, stop ?? limit].filter(Boolean).join(" ");
}

function PageNav({ t, busy, onBack }: { t: Translator; busy: boolean; onBack?: () => void }) {
  return onBack ? <nav className="holdingNav"><button type="button" className="linkButton" disabled={busy} onClick={onBack}>‹ {t("backToHoldings")}</button></nav> : null;
}

/** One order: where it stands, how much of it filled and at what prices, with a way to its holding and to cancel it while open. */
/** `justCancelled`: a cancellation of this order was just sent, which Trading 212 may not show yet. */
export function OrderStatusView({ data, book, locale, t, busy, writeEnabled, justCancelled = false, onOpen, onCancel, onChange, onBack, onRefresh }: {
  data: OrderStatusReport; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy: boolean; writeEnabled: boolean; justCancelled?: boolean;
  onOpen?: (ticker: string) => void; onCancel?: (orderId: string) => void; onChange?: (order: PendingOrder) => void; onBack?: () => void; onRefresh?: () => void;
}) {
  const order = data.order;
  const ticker = order?.ticker;
  const label = ticker ? instrumentLabel(ticker, book) : undefined;
  // A sell by amount in the Trading 212 app has a negative value and may have no side.
  const sell = String(order?.side ?? "").toUpperCase() === "SELL" || Number(order?.quantity ?? 0) < 0 || Number(order?.value ?? 0) < 0;
  const ordered = Math.abs(Number(order?.quantity ?? 0));
  const filled = Math.max(Math.abs(Number(order?.filledQuantity ?? 0)), data.fills.reduce((sum, item) => sum + (item.quantity ?? 0), 0));
  const priceCurrency = typeof order?.currency === "string" ? order.currency : ticker ? instrumentCurrency(ticker, book) : undefined;
  // An order by amount fills toward its value; how far is known when Trading 212 says what has filled of it.
  const byValue = ordered === 0 && typeof order?.value === "number" && order.value !== 0;
  const valueFilled = byValue && typeof order?.filledValue === "number" ? Math.abs(order.filledValue) : undefined;
  const share = ordered > 0 ? Math.min(1, filled / ordered) : valueFilled !== undefined ? Math.min(1, valueFilled / Math.abs(order!.value!)) : data.state === "filled" ? 1 : undefined;
  const progress = ordered > 0 ? `${qty(filled, locale)} / ${qty(ordered, locale)}`
    : valueFilled !== undefined ? `${amount(valueFilled, priceCurrency, locale)} / ${amount(Math.abs(order!.value!), priceCurrency, locale)}` : qty(filled, locale);
  // Averaged over the fills that have a price, so a fill read without one does not pull it down.
  const priced = data.fills.filter((item) => item.price !== undefined && (item.quantity ?? 0) > 0);
  const pricedQuantity = priced.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const average = pricedQuantity > 0 ? priced.reduce((sum, item) => sum + item.price! * item.quantity!, 0) / pricedQuantity : undefined;
  const valued = data.fills.filter((item) => item.netValue !== undefined);
  const value = valued.length ? valued.reduce((sum, item) => sum + Math.abs(item.netValue!), 0) : undefined;
  const accountCurrency = data.fills.find((item) => item.currency)?.currency;
  const open = (data.state === "open" || data.state === "partly_filled") && !justCancelled;
  return (
    <main className="contentStack">
      <PageNav t={t} busy={busy} onBack={onBack} />
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{fill(t("orderNumber"), { id: data.orderId })}<span className={`statusPill ${STATE_TONES[data.state]} taxRunning`}>{t(STATE_KEYS[data.state])}</span></span>
          {label && ticker ? (
            <div className="historyWho orderStatusWho">
              <AssetAvatar ticker={ticker} label={label} />
              <div>
                {onOpen ? <button type="button" className="inlineLink reviewName" disabled={busy} title={ticker} onClick={() => onOpen(ticker)}>{label.name}</button> : <strong title={ticker}>{label.name}</strong>}
                <small>
                  <b className={`orderSide ${sell ? "sell" : "buy"}`}>{sell ? t("sell") : t("buy")}</b>
                  {` ${order?.strategy === "VALUE" && order.value !== undefined ? amount(Math.abs(order.value), priceCurrency, locale) : qty(ordered, locale)} · ${orderTerms(order, priceCurrency, t, locale)}`}
                </small>
              </div>
            </div>
          ) : <strong className="heroValue">{t(STATE_KEYS[data.state])}</strong>}
          {justCancelled && data.state !== "cancelled" ? <span className="overviewSubline">{t("orderJustCancelled")}</span>
            : data.state === "not_found" && <span className="overviewSubline">{t("orderNotFoundHint")}</span>}
          {order?.createdAt && <span className="overviewSubline">{fill(t("orderPlacedAt"), { when: dateTime(order.createdAt, locale) })}</span>}
        </div>
        {(ordered > 0 || filled > 0 || valueFilled !== undefined) && (
          <div className="usageMeter orderFillMeter">
            <div className="usageMeterHead"><span>{t("orderFilledShare")}</span><strong>{progress}</strong></div>
            {share !== undefined && <div className="usageMeterTrack" role="meter" aria-label={t("orderFilledShare")} aria-valuemin={0} aria-valuemax={1} aria-valuenow={share} aria-valuetext={progress}><i style={{ width: `${share * 100}%` }} /></div>}
          </div>
        )}
        {data.fills.length > 0 && (
          <div className="metricGrid">
            <Metric label={t("orderAverageFill")} value={amount(average, priceCurrency, locale, { digits: 4 })} />
            <Metric label={t("orderFillValue")} value={value === undefined ? "—" : accountCurrency ? money(value, accountCurrency, locale) : amount(value, undefined, locale)} />
          </div>
        )}
      </section>
      {data.fills.length > 0 && (
        <section className="dataPanel">
          <div className="pieHeader"><h2>{t("orderFills")}</h2></div>
          <ul className="historyList">
            {data.fills.map((item, index) => (
              <li key={`${item.filledAt ?? ""}-${index}`} className="historyRow">
                <div className="historyWho"><div><strong>{item.filledAt ? dateTime(item.filledAt, locale) : "—"}</strong><small>{`${item.quantity === undefined ? "—" : qty(item.quantity, locale)} × ${amount(item.price, priceCurrency, locale, { digits: 4 })}`}</small></div></div>
                <strong className="historyAmount">{item.netValue === undefined ? "—" : amount(Math.abs(item.netValue), item.currency ?? accountCurrency, locale)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="toolActions">
        {onRefresh && <button type="button" className="secondaryButton" disabled={busy} onClick={onRefresh}>{t("orderCheckAgain")}</button>}
        {open && writeEnabled && onChange && order && data.state === "open" && !changeBlock(order) && <button type="button" className="secondaryButton" disabled={busy} onClick={() => onChange({ ...order, id: order.id ?? data.orderId })}>{t("prepareChange")}</button>}
        {open && writeEnabled && onCancel && <button type="button" className="secondaryButton danger" disabled={busy} onClick={() => onCancel(data.orderId)}>{t("prepareCancel")}</button>}
      </div>
    </main>
  );
}

export interface ExportPayload {
  kind: "history_export";
  environment: TradingEnvironment;
  /** `list`: the reports there are. */
  reports?: ExportReport[];
  /** `request`: the report asked for, or the one that already holds the period. */
  requested?: { reportId: number; reused?: ExportReport };
  /** `read`: the report, and what it adds up to once it is finished. */
  report?: ExportReport;
  summary?: ExportSummary;
  recordCount?: number;
}

const finished = (report: ExportReport) => /finish/i.test(report.status ?? "");
const failed = (report: ExportReport) => /fail|cancel/i.test(report.status ?? "");
/** Trading 212's report statuses (Queued, Processing, Running, Finished, Canceled, Failed) in words. */
function exportStatus(report: ExportReport, t: Translator): string {
  if (finished(report)) return t("exportFinished");
  if (failed(report)) return t("exportFailed");
  return report.status ? t("exportBuilding") : "—";
}
/** A total in each currency it has, the largest first; "?" is a currency the file did not name. */
function totalsText(totals: ExportTotals, locale: SupportedLocale, signed = false): string {
  const entries = Object.entries(totals).filter(([, value]) => value !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return entries.length ? entries.map(([currency, value]) => (currency === "?" ? amount(value, undefined, locale, { signed }) : money(value, currency, locale, { signed }))).join(" · ") : "—";
}
const totalOf = (totals: ExportTotals) => Object.values(totals).reduce((sum, value) => sum + value, 0);
function span(report: ExportReport, t: Translator, locale: SupportedLocale): string {
  return report.timeFrom ? fill(t("taxSpan"), { from: dayLabel(report.timeFrom, locale), to: report.timeTo ? dayLabel(report.timeTo, locale) : "—" }) : "—";
}

/** A country's name from its ISIN prefix, in the page's language; the code itself when the browser has no name for it. */
function countryName(code: string, locale: SupportedLocale, t: Translator): string {
  if (code === "?") return t("withholdingNoIsin");
  try { return new Intl.DisplayNames([localeTag(locale)], { type: "region" }).of(code) ?? code; } catch { return code; }
}

/** The tax withheld from dividends, by country: the rate, what it came to, and a note where US dividends lost 30%. */
function WithholdingPanel({ summary, rows, locale, t }: { summary: ExportSummary; rows: NonNullable<ExportSummary["withholding"]>; locale: SupportedLocale; t: Translator }) {
  const high = rows.flatMap((row) => row.highTickers ?? []);
  const basis = summary.withholdingBasis ?? "assumed";
  return (
    <section className="dataPanel">
      <div className="pieHeader"><h2>{t("withholdingTitle")}</h2></div>
      {high.length > 0 && <div className="notice warning compactNotice" role="note">{fill(t("withholdingHigh"), { tickers: high.join(", ") })}</div>}
      {rows.length > 0 && <ul className="historyList">
        {rows.map((row) => (
          <li key={`${row.country}:${row.currency}`} className="historyRow">
            <div className="historyWho"><div>
              <strong>{countryName(row.country, locale, t)}</strong>
              <small>{[row.tickers.slice(0, 6).join(", ") + (row.tickers.length > 6 ? " …" : ""), plural(row.payments, locale, t("withholdingPaymentsOne"), t("withholdingPayments"))].filter(Boolean).join(" · ")}</small>
            </div></div>
            <div className="historyAmount withholdingAmount">
              <strong className={row.high ? "negative" : undefined}>{pct(row.rate, locale)}</strong>
              <small>{fill(t("withholdingOf"), { withheld: money(row.withheld, row.currency, locale), gross: money(row.gross, row.currency, locale) })}</small>
            </div>
          </li>
        ))}
      </ul>}
      <p className="panelNote">
        {[rows.length > 0 && t(basis === "net" ? "withholdingBasisNet" : basis === "gross" ? "withholdingBasisGross" : "withholdingBasisAssumed"),
          summary.withholdingUnread ? plural(summary.withholdingUnread, locale, t("withholdingUnreadOne"), t("withholdingUnread")) : "",
          rows.length > 0 && t("withholdingNote")].filter(Boolean).join(locale === "zh-CN" ? "" : " ")}
      </p>
    </section>
  );
}

/** Trading 212's CSV reports: the list with a way to read each finished one, a request's outcome, or what one report adds up to. */
export function ExportView({ data, locale, t, busy, onRead, onList, onBack }: {
  data: ExportPayload; locale: SupportedLocale; t: Translator; busy: boolean; onRead?: (reportId: number) => void; onList?: () => void; onBack?: () => void;
}) {
  const reports = data.reports ? [...data.reports].sort((a, b) => b.reportId - a.reportId) : undefined;
  const summary = data.summary;
  return (
    <main className="contentStack">
      <PageNav t={t} busy={busy} onBack={onBack} />
      {data.requested && (
        <div className="notice compactNotice exportNotice" role="status">
          <span>{fill(t(data.requested.reused ? "exportReused" : "exportRequested"), { id: String(data.requested.reportId) })}</span>
          {onRead && <button type="button" className="linkButton" disabled={busy} onClick={() => onRead(data.requested!.reportId)}>{t("exportRead")}</button>}
        </div>
      )}
      {data.report && !summary && (
        <div className="notice warning compactNotice exportNotice" role="status">
          <span>{fill(t(failed(data.report) ? "exportFailedHint" : "exportNotReady"), { id: String(data.report.reportId) })}</span>
          {onRead && !failed(data.report) && <button type="button" className="linkButton" disabled={busy} onClick={() => onRead(data.report!.reportId)}>{t("exportReadAgain")}</button>}
        </div>
      )}
      {data.report && summary && (
        <>
          <section className="overviewPanel">
            <div className="overviewLead">
              <span className="sectionEyebrow">{fill(t("exportReport"), { id: String(data.report.reportId) })}</span>
              <strong className="heroValue small exportSpan">{span(data.report, t, locale)}</strong>
              <span className="overviewSubline">{plural(summary.rows, locale, t("exportRowsOne"), t("exportRows"))}{summary.first && summary.last ? ` · ${summary.first.slice(0, 10)} – ${summary.last.slice(0, 10)}` : ""}</span>
            </div>
            <div className="metricGrid">
              <Metric label={t("exportResult")} value={totalsText(summary.result, locale, true)} tone={signedClass(totalOf(summary.result))} />
              <Metric label={t("exportDividends")} value={totalsText(summary.dividends, locale)} />
              <Metric label={t("interest")} value={totalsText(summary.interest, locale)} />
            </div>
          </section>
          {summary.charges.length > 0 && (
            <section className="dataPanel">
              <div className="pieHeader"><h2>{t("exportCharges")}</h2></div>
              <div className="confirmationRows">{summary.charges.map((charge) => <DetailRow key={charge.name} label={charge.name} value={totalsText(charge.totals, locale)} />)}</div>
            </section>
          )}
          {summary.withholding && (summary.withholding.length > 0 || !!summary.withholdingUnread) && <WithholdingPanel summary={summary} rows={summary.withholding} locale={locale} t={t} />}
          <section className="dataPanel">
            <div className="pieHeader"><h2>{t("exportActions")}</h2></div>
            <ul className="historyList">
              {summary.actions.map((action) => (
                <li key={action.action} className="historyRow">
                  <div className="historyWho"><div><strong>{action.action}</strong><small>{plural(action.count, locale, t("exportRowsOne"), t("exportRows"))}</small></div></div>
                  <strong className="historyAmount">{totalsText(action.totals, locale)}</strong>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {reports && (
        <section className="dataPanel">
          <div className="pieHeader"><h2>{t("exportTitle")}</h2></div>
          {reports.length === 0 ? <div className="emptyState compact">{t("exportNone")}</div> : (
            <ul className="historyList exportList">
              {reports.map((report) => (
                <li key={report.reportId} className="historyRow">
                  <div className="historyWho"><div><strong>{span(report, t, locale)}</strong><small>{fill(t("exportReport"), { id: String(report.reportId) })}</small></div></div>
                  <div className="exportRowEnd">
                    <span className={`statusPill ${finished(report) ? "auto" : failed(report) ? "ended" : "fired"}`} title={report.status}>{exportStatus(report, t)}</span>
                    {finished(report) && onRead && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => onRead(report.reportId)}>{t("exportRead")}</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {onList && !reports && <div className="toolActions"><button type="button" className="secondaryButton" disabled={busy} onClick={onList}>{t("exportAll")}</button></div>}
    </main>
  );
}
