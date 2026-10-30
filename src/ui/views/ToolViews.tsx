import type { OrderStatusReport, TradingEnvironment } from "../../shared/contracts";
import type { ExportReport, ExportSummary, ExportTotals } from "../../shared/history";
import type { MessageKey, SupportedLocale } from "../i18n";
import { AssetAvatar, DetailRow, Metric } from "../components/common";
import { amount, dateTime, dayLabel, money, qty, signedClass } from "../lib/format";
import { instrumentCurrency, instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, orderTypeLabel, plural, type Translator } from "../lib/messages";

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

function PageNav({ t, busy, onBack }: { t: Translator; busy: boolean; onBack?: () => void }) {
  return onBack ? <nav className="holdingNav"><button type="button" className="linkButton" disabled={busy} onClick={onBack}>‹ {t("backToHoldings")}</button></nav> : null;
}

/** One order: where it stands, how much of it filled and at what prices, with a way to its holding and to cancel it while open. */
export function OrderStatusView({ data, book, locale, t, busy, writeEnabled, onOpen, onCancel, onBack, onRefresh }: {
  data: OrderStatusReport; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy: boolean; writeEnabled: boolean;
  onOpen?: (ticker: string) => void; onCancel?: (orderId: string) => void; onBack?: () => void; onRefresh?: () => void;
}) {
  const order = data.order;
  const ticker = order?.ticker;
  const label = ticker ? instrumentLabel(ticker, book) : undefined;
  const sell = String(order?.side ?? "").toUpperCase() === "SELL" || Number(order?.quantity ?? 0) < 0;
  const ordered = Math.abs(Number(order?.quantity ?? 0));
  const filled = Math.max(Math.abs(Number(order?.filledQuantity ?? 0)), data.fills.reduce((sum, item) => sum + (item.quantity ?? 0), 0));
  const share = ordered > 0 ? Math.min(1, filled / ordered) : data.state === "filled" ? 1 : 0;
  const average = filled > 0 && data.fills.length ? data.fills.reduce((sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0), 0) / filled : undefined;
  const value = data.fills.reduce((sum, item) => sum + Math.abs(item.netValue ?? 0), 0);
  const accountCurrency = data.fills.find((item) => item.currency)?.currency;
  const priceCurrency = typeof order?.currency === "string" ? order.currency : ticker ? instrumentCurrency(ticker, book) : undefined;
  const open = data.state === "open" || data.state === "partly_filled";
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
                  {` ${order?.strategy === "VALUE" && order.value !== undefined ? amount(Math.abs(order.value), priceCurrency, locale) : qty(ordered, locale)} · ${orderTypeLabel(String(order?.type ?? ""), t)}`}
                  {order?.limitPrice !== undefined ? ` · ${t("limitPrice")} ${amount(order.limitPrice, priceCurrency, locale, { digits: 4 })}` : ""}
                  {order?.stopPrice !== undefined ? ` · ${t("stopPrice")} ${amount(order.stopPrice, priceCurrency, locale, { digits: 4 })}` : ""}
                </small>
              </div>
            </div>
          ) : <strong className="heroValue">{t(STATE_KEYS[data.state])}</strong>}
          {data.state === "not_found" && <span className="overviewSubline">{t("orderNotFoundHint")}</span>}
          {order?.createdAt && <span className="overviewSubline">{fill(t("orderPlacedAt"), { when: dateTime(order.createdAt, locale) })}</span>}
        </div>
        {(ordered > 0 || filled > 0) && (
          <div className="usageMeter orderFillMeter">
            <div className="usageMeterHead"><span>{t("orderFilledShare")}</span><strong>{ordered > 0 ? `${qty(filled, locale)} / ${qty(ordered, locale)}` : qty(filled, locale)}</strong></div>
            <div className="usageMeterTrack" role="meter" aria-label={t("orderFilledShare")} aria-valuemin={0} aria-valuemax={1} aria-valuenow={share}><i style={{ width: `${share * 100}%` }} /></div>
          </div>
        )}
        {data.fills.length > 0 && (
          <div className="metricGrid">
            <Metric label={t("orderAverageFill")} value={amount(average, priceCurrency, locale, { digits: 4 })} />
            <Metric label={t("orderFillValue")} value={money(value, accountCurrency ?? "EUR", locale)} />
          </div>
        )}
      </section>
      {data.fills.length > 0 && (
        <section className="dataPanel">
          <div className="pieHeader"><h2>{t("orderFills")}</h2></div>
          <ul className="historyList">
            {data.fills.map((item, index) => (
              <li key={`${item.filledAt ?? ""}-${index}`} className="historyRow">
                <div className="historyWho"><div><strong>{item.filledAt ? dateTime(item.filledAt, locale) : "—"}</strong><small>{`${qty(item.quantity ?? 0, locale)} × ${amount(item.price, priceCurrency, locale, { digits: 4 })}`}</small></div></div>
                <strong className="historyAmount">{item.netValue === undefined ? "—" : money(Math.abs(item.netValue), item.currency ?? accountCurrency ?? "EUR", locale)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="toolActions">
        {onRefresh && <button type="button" className="secondaryButton" disabled={busy} onClick={onRefresh}>{t("orderCheckAgain")}</button>}
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
