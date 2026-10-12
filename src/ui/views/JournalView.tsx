import { useState } from "react";
import type { TradingEnvironment } from "../../shared/contracts";
import type { JournalReview, JournalTagStats, JournalTrade } from "../../shared/journal";
import type { SupportedLocale } from "../i18n";
import { Metric } from "../components/common";
import { JournalForm, type JournalRequest } from "../components/journal";
import { amount, dayLabel, money, pct, qty, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, plural, type Translator } from "../lib/messages";
import { PeriodSwitch, type InsightPeriod } from "./InsightsView";

/** The tag filter: a tag's lower-case name, NO_TAG for the trades without one, or null for all. */
const NO_TAG = "\u0000";
const tagKey = (row: Pick<JournalTagStats, "tag">) => row.tag === undefined ? NO_TAG : row.tag.toLowerCase();
const hasTag = (trade: JournalTrade, key: string) => key === NO_TAG ? !trade.entry.tags?.length : trade.entry.tags?.some((tag) => tag.toLowerCase() === key) ?? false;

/** The move in the trade's favour as words, so the colour is never the only sign of which way it went. */
function edgeText(edge: number, locale: SupportedLocale, t: Translator): string {
  if (Math.abs(edge) < 0.0005) return t("reviewFlat");
  return fill(t(edge > 0 ? "reviewInFavour" : "reviewAgainst"), { value: pct(Math.abs(edge), locale) });
}

/**
 * One tag's trades: how many, how many went your way, and the average edge as a bar from a centre line,
 * right for your way and left against, on one scale for every row so lengths compare.
 */
function TagRow({ row, scale, active, locale, t, onSelect }: { row: JournalTagStats; scale: number; active: boolean; locale: SupportedLocale; t: Translator; onSelect: () => void }) {
  const edge = row.averageEdge;
  const width = edge === undefined ? 0 : Math.min(50, (Math.abs(edge) / scale) * 50);
  return (
    <li>
      <button type="button" className={`reviewTag${active ? " active" : ""}`} aria-pressed={active} onClick={onSelect}>
        <span className="reviewTagName">{row.tag === undefined ? t("reviewNoTag") : `#${row.tag}`}</span>
        <span className="reviewTagFacts">
          {plural(row.trades, locale, t("reviewTagTradesOne"), t("reviewTagTrades"))}
          {row.priced > 0 && <> · {fill(t("reviewTagWins"), { part: String(row.inFavour), total: String(row.priced) })}</>}
        </span>
        <span className="edgeTrack" aria-hidden="true">
          {edge !== undefined && width > 0 && <span className={`edgeFill ${signedClass(edge)}`} style={edge > 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }} />}
        </span>
        <strong className={`reviewTagEdge ${signedClass(edge)}`}>{edge === undefined ? "—" : pct(edge, locale, 1, { signed: true })}</strong>
      </button>
    </li>
  );
}

function TradeCard({ trade, currency, book, locale, t, busy, editing, onOpen, onEdit, onSave, onCancel }: {
  trade: JournalTrade; currency: string; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy: boolean; editing?: "review" | "all";
  onOpen?: (ticker: string) => void; onEdit: (focus?: "review") => void; onSave: (request: JournalRequest) => void; onCancel: () => void;
}) {
  const { entry } = trade;
  const label = instrumentLabel(trade.ticker, book, trade.name ? { name: trade.name } : undefined);
  return (
    <li className={`journalNote reviewTrade${trade.due ? " due" : ""}`}>
      <div className="journalHead">
        <strong>{dayLabel(trade.filledAt, locale)}</strong>
        {onOpen
          ? <button type="button" className="inlineLink reviewName" title={trade.ticker} aria-label={fill(t("openHolding"), { name: label.name })} disabled={busy} onClick={() => onOpen(trade.ticker)}>{label.name}</button>
          : <span className="reviewName" title={trade.ticker}>{label.name}</span>}
        <span className={`journalOrder ${trade.side}`}>{trade.side === "sell" ? t("sell") : t("buy")} {qty(trade.quantity, locale)} · {amount(trade.price, trade.priceCurrency, locale)}</span>
        {trade.due && <span className="statusPill fired">{t("reviewDue")}</span>}
      </div>
      <div className="reviewOutcome">
        {trade.edge === undefined ? <span className="mutedInline">{t("reviewNoPrice")}</span> : (
          <>
            <span>{fill(t("reviewNow"), { price: amount(trade.priceNow, trade.priceCurrency, locale) })}</span>
            <span className={`edgeBadge ${signedClass(Math.abs(trade.edge) < 0.0005 ? 0 : trade.edge)}`}>{edgeText(trade.edge, locale, t)}</span>
          </>
        )}
        {trade.realisedProfitLoss !== undefined && trade.realisedProfitLoss !== 0 && (
          <span className={signedClass(trade.realisedProfitLoss)}>{fill(t("reviewRealised"), { value: money(trade.realisedProfitLoss, currency, locale, { signed: true }) })}</span>
        )}
      </div>
      {/* The trade stays in view above the form, so the look back is written against how it went. */}
      {editing ? <JournalForm entry={entry} {...(editing === "review" ? { focus: "review" as const } : {})} t={t} busy={busy} onSave={onSave} onCancel={onCancel} /> : (
        <>
          {entry.thesis && <div className="journalText"><span>{t("journalWhy")}</span><p>{entry.thesis}</p></div>}
          {entry.review && <div className="journalText review"><span>{t("journalReview")}</span><p>{entry.review}</p></div>}
          {entry.tags?.length ? <div className="journalTags">{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
          <div className="alertActions">
            {!entry.review && <button type="button" className="linkButton" disabled={busy} onClick={() => onEdit("review")}>{t("journalAddReview")}</button>}
            <button type="button" className="linkButton" disabled={busy} onClick={() => onEdit()}>{t("journalEdit")}</button>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * The journal looked back on: each trade with a note next to how it has gone since, the share of trades with a
 * reason, how often the reasons went your way per tag, and the trades due for a look back, which can be written here.
 */
export function JournalReviewView({ data, book, locale, t, period, busy, onPeriod, onOpen, onSaveNote }: {
  data: JournalReview; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod; busy: boolean;
  onPeriod: (next: InsightPeriod) => void;
  onOpen?: (ticker: string) => void;
  onSaveNote: (environment: TradingEnvironment, input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; focus: "review" | "all" } | null>(null);
  const { overall } = data;
  const currency = data.accountCurrency ?? "EUR";
  const rows = data.tags.length ? data.tags : [];
  const scale = Math.max(0.01, ...rows.map((row) => Math.abs(row.averageEdge ?? 0)));
  const active = filter !== null && rows.some((row) => tagKey(row) === filter) ? filter : null;
  const trades = active === null ? data.trades : data.trades.filter((trade) => hasTag(trade, active));
  const realised = overall.realisedProfitLoss;
  const save = async (trade: JournalTrade, request: JournalRequest) => {
    const saved = await onSaveNote(data.environment, { action: "update", entryId: trade.entry.id, thesis: request.thesis, review: request.review, tags: request.tags });
    if (saved) setEditing(null);
  };
  return (
    <main className="contentStack">
      <div className="viewToolbar"><PeriodSwitch value={period} onChange={onPeriod} t={t} disabled={busy} /></div>
      {data.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("reviewAverageEdge")}</span>
          <strong className={`heroValue ${signedClass(overall.averageEdge)}`}>{overall.averageEdge === undefined ? "—" : pct(overall.averageEdge, locale, 1, { signed: true })}</strong>
          {overall.priced > 0 && (
            <div className={`pnlBadge ${overall.inFavour * 2 >= overall.priced ? "positive" : "negative"}`}>
              {t("reviewYourWay")} · {fill(t("reviewOf"), { part: String(overall.inFavour), total: String(overall.priced) })}
            </div>
          )}
        </div>
        <div className="metricGrid">
          <Metric label={t("reviewWithNote")} value={fill(t("reviewOf"), { part: String(data.withNote), total: String(data.fills) })} />
          <Metric label={t("reviewLookedBack")} value={fill(t("reviewOf"), { part: String(data.reviewed), total: String(data.withNote) })} />
          <Metric label={t("reviewDue")} value={String(data.due)} {...(data.due ? { tone: "dueCount" } : {})} />
          <Metric label={t("reviewRealisedNoted")} value={money(realised, currency, locale, { signed: true })} tone={signedClass(realised)} />
        </div>
      </section>
      <p className="panelNote reviewEdgeNote">{t("reviewEdgeNote")}</p>

      {rows.length > 0 && (
        <section className="dataPanel">
          <h2 className="panelTitle">{t("reviewByTag")}</h2>
          <ul className="reviewTags" aria-label={t("reviewFilter")}>
            {rows.map((row) => {
              const key = tagKey(row);
              return <TagRow key={key} row={row} scale={scale} active={active === key} locale={locale} t={t} onSelect={() => setFilter(active === key ? null : key)} />;
            })}
          </ul>
        </section>
      )}

      <section className="dataPanel">
        <div className="panelHeading">
          <h2 className="panelTitle">{t("reviewTrades")}{active !== null && <span className="reviewFilterName"> · {active === NO_TAG ? t("reviewNoTag") : `#${rows.find((row) => tagKey(row) === active)?.tag ?? ""}`}</span>}</h2>
          {active !== null && <div className="panelActions"><button type="button" className="secondaryButton compactButton" onClick={() => setFilter(null)}>{t("reviewAll")}</button></div>}
        </div>
        {trades.length === 0 ? <div className="emptyState compact">{active === null ? t("reviewEmpty") : t("reviewEmptyTag")}</div> : (
          <ul className="journalList">
            {trades.map((trade) => (
              <TradeCard key={trade.entry.id} trade={trade} currency={currency} book={book} locale={locale} t={t} busy={busy}
                {...(editing?.id === trade.entry.id ? { editing: editing.focus } : {})}
                {...(onOpen ? { onOpen } : {})}
                onEdit={(focus) => setEditing({ id: trade.entry.id, focus: focus ?? "all" })}
                onSave={(request) => void save(trade, request)}
                onCancel={() => setEditing(null)} />
            ))}
          </ul>
        )}
        {(data.tradesTotal > data.trades.length || data.unmatched > 0 || data.withoutOrder > 0 || data.unpriced.length > 0) && (
          <ul className="reviewFootnotes">
            {data.tradesTotal > data.trades.length && <li>{fill(t("reviewMore"), { shown: String(data.trades.length), total: String(data.tradesTotal) })}</li>}
            {data.unpriced.length > 0 && <li>{fill(t("reviewUnpriced"), { list: data.unpriced.map((ticker) => instrumentLabel(ticker, book).name).join(", ") })}</li>}
            {data.unmatched > 0 && <li>{plural(data.unmatched, locale, t("reviewUnmatchedOne"), t("reviewUnmatched"))}</li>}
            {data.withoutOrder > 0 && <li>{plural(data.withoutOrder, locale, t("reviewWithoutOrderOne"), t("reviewWithoutOrder"))}</li>}
          </ul>
        )}
      </section>
    </main>
  );
}
