import { useState, type FormEvent } from "react";
import type { Instrument } from "../../shared/contracts";
import { MAX_WATCH_NOTE, WATCH_PERIODS, type WatchLevel, type WatchlistView as WatchlistData, type WatchPeriod, type WatchRow } from "../../shared/watchlist";
import type { MessageKey, SupportedLocale } from "../i18n";
import { AssetAvatar, Icon } from "../components/common";
import { Select } from "../components/select";
import { InstrumentSearch } from "../components/instrument-search";
import { priceDigits } from "../components/price-chart";
import { amount, dayLabel, pct, qty, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, plural, quoteProviderLabel, type Translator } from "../lib/messages";
import { MISSING_KEYS } from "./HoldingView";
import { radioKeys, radioTab } from "../lib/radio";

export type WatchSort = "added" | "move" | "level";

/** Each period's button text, its full name, and the change over it in a sentence. */
const PERIOD_KEYS: Record<WatchPeriod, [MessageKey, MessageKey, MessageKey]> = {
  "1d": ["period1dShort", "period1d", "watchChange1d"],
  "1m": ["period1mShort", "period1m", "watchChange1m"],
  "3m": ["period3mShort", "period3m", "watchChange3m"],
  "1y": ["period1yShort", "period1y", "watchChange1y"],
};
const SPARK = { width: 76, height: 30, pad: 3 };

/** Three months of closes as a small line, green when it ends above where it started and red below, with the start dotted across. */
export function WatchSpark({ closes }: { closes: number[] }) {
  const { width, height, pad } = SPARK;
  if (closes.length < 2) return <span className="watchSpark empty" aria-hidden="true" />;
  const low = Math.min(...closes);
  const span = Math.max(...closes) - low || 1;
  const x = (index: number) => pad + (index / (closes.length - 1)) * (width - 2 * pad);
  const y = (value: number) => pad + (1 - (value - low) / span) * (height - 2 * pad);
  const line = closes.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const first = closes[0]!;
  return (
    <svg className={`watchSpark ${closes[closes.length - 1]! >= first ? "positive" : "negative"}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <line className="watchSparkStart" x1={pad} x2={width - pad} y1={y(first)} y2={y(first)} />
      <path d={line} />
    </svg>
  );
}

/** An open order or alert, and how far the price is from it. */
export function watchLevelText(level: WatchLevel, currency: string | undefined, locale: SupportedLocale, t: Translator): string {
  const key: MessageKey = level.kind === "alert"
    ? (level.condition === "above" ? "watchAlertAbove" : "watchAlertBelow")
    : level.kind === "limit" ? (level.side === "sell" ? "watchSellLimit" : "watchBuyLimit") : (level.side === "sell" ? "watchSellStop" : "watchBuyStop");
  const text = fill(t(key), { price: amount(level.price, currency, locale, { digits: priceDigits(level.price) }) });
  return level.distance === undefined ? text : `${text} · ${pct(level.distance, locale, 1, { signed: true })}`;
}

/** Where the price sits in its 12-month range: a dot on a track from the low to the high, and the distance from the high in words. */
function RangeBar({ row, locale, t }: { row: WatchRow; locale: SupportedLocale; t: Translator }) {
  if (row.high === undefined || row.low === undefined || row.price === undefined || !(row.high > 0)) return null;
  const at = row.high > row.low ? Math.min(1, Math.max(0, (row.price - row.low) / (row.high - row.low))) : 1;
  const below = 1 - row.price / row.high;
  const since = row.rangeFrom ? dayLabel(row.rangeFrom, locale) : undefined;
  const range = fill(t(since ? "watchRangeSinceLabel" : "watchRangeLabel"), {
    low: amount(row.low, row.currencyCode, locale, { digits: priceDigits(row.low) }),
    high: amount(row.high, row.currencyCode, locale, { digits: priceDigits(row.high) }),
    ...(since ? { date: since } : {}),
  });
  return (
    <span className="watchRange" title={range}>
      <span className="rangeTrack" aria-hidden="true"><i style={{ left: `${(at * 100).toFixed(1)}%` }} /></span>
      {below < 0.0005
        ? (since ? fill(t("watchAtHighSince"), { date: since }) : t("watchAtHigh"))
        : fill(t(since ? "watchFromHighSince" : "watchFromHigh"), { value: pct(below, locale), ...(since ? { date: since } : {}) })}
    </span>
  );
}

function missingText(row: WatchRow, t: Translator): string {
  if (row.pricesMissing === "later") return t("watchMissingLater");
  const text = t(MISSING_KEYS[row.pricesMissing!]);
  // The provider's own words for the cases only it can explain, as on the holding page.
  return (row.pricesMissing === "data" || row.pricesMissing === "unit") && row.pricesProblem ? `${text} ${row.pricesProblem}` : text;
}

function WatchItem({ row, period, book, locale, t, busy, onOpen, onRemove, onNote }: {
  row: WatchRow; period: WatchPeriod; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy: boolean;
  onOpen: (ticker: string) => void; onRemove: (ticker: string) => void; onNote: (ticker: string, note: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.note ?? "");
  const label = instrumentLabel(row.ticker, book, { ...(row.name ? { name: row.name } : {}), ...(row.shortName ? { shortName: row.shortName } : {}) });
  const change = row.changes[period];
  const price = row.price === undefined ? undefined : amount(row.price, row.currencyCode, locale, { digits: priceDigits(row.price) });
  const changeText = change === undefined ? undefined : pct(change, locale, 1, { signed: true });
  const changeWords = changeText === undefined ? undefined : fill(t(PERIOD_KEYS[period][2]), { value: changeText });
  const held = row.held ? fill(t("watchHeld"), { quantity: qty(row.held.quantity, locale) }) : undefined;
  const nearest = row.levels[0];
  const save = (event: FormEvent) => {
    event.preventDefault();
    void onNote(row.ticker, draft.trim()).then((saved) => { if (saved) setEditing(false); });
  };
  return (
    <li className="watchRow">
      <button type="button" className="watchMain" disabled={busy} title={row.ticker} onClick={() => onOpen(row.ticker)}
        aria-label={fill(t("watchOpen"), { name: label.name, price: price ?? t("watchNoPrice"), change: changeWords ?? "" }).replace(/[,，]\s*$/, "")}>
        <AssetAvatar ticker={row.ticker} label={label} />
        <span className="watchName"><strong>{label.name}</strong><small>{label.detail || row.ticker}{held ? <> · <span className="noWrap">{held}</span></> : null}</small></span>
        {row.spark ? <WatchSpark closes={row.spark.closes} /> : <span className="watchSpark empty" aria-hidden="true" />}
        <span className="watchQuote">
          <strong>{price ?? "—"}</strong>
          <span className={`changeChip ${signedClass(change)}`} title={changeWords}>{changeText ?? "—"}</span>
        </span>
      </button>
      <button type="button" className="removeLegButton watchRemove" disabled={busy} aria-label={fill(t("watchRemove"), { name: label.name })} title={fill(t("watchRemove"), { name: label.name })} onClick={() => onRemove(row.ticker)}>
        <Icon name="close" />
      </button>
      <div className="watchMeta">
        <RangeBar row={row} locale={locale} t={t} />
        {nearest && <span className={`watchLevel ${nearest.kind}`}>{watchLevelText(nearest, row.currencyCode, locale, t)}</span>}
        {row.levels.length > 1 && <span>{plural(row.levels.length - 1, locale, t("watchMoreLevelsOne"), t("watchMoreLevels"))}</span>}
        {/* Added in the last day, the change since is noise. */}
        {row.sinceAdded !== undefined && Date.now() - Date.parse(row.addedAt) >= 86_400_000 && <span>{fill(t("watchSince"), { change: pct(row.sinceAdded, locale, 1, { signed: true }), date: dayLabel(row.addedAt, locale) })}</span>}
        {row.priceSource === "close" && row.priceAt && <span>{fill(t("watchPriceClose"), { date: dayLabel(row.priceAt, locale) })}</span>}
        {row.pricesMissing && <span className="watchMissing">{missingText(row, t)}</span>}
      </div>
      {editing ? (
        <form className="watchNoteForm" onSubmit={save}>
          <input type="text" aria-label={fill(t("watchNoteLabel"), { name: label.name })} maxLength={MAX_WATCH_NOTE} value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="secondaryButton compactButton" disabled={busy}>{t("watchNoteSave")}</button>
          <button type="button" className="linkButton" onClick={() => setEditing(false)}>{t("cancel")}</button>
        </form>
      ) : (
        <p className="watchNote">
          {row.note && <span>{row.note}</span>}
          <button type="button" className="inlineLink" disabled={busy} aria-label={`${t(row.note ? "watchNoteEdit" : "watchNoteAdd")}: ${label.name}`} onClick={() => { setDraft(row.note ?? ""); setEditing(true); }}>
            {t(row.note ? "watchNoteEdit" : "watchNoteAdd")}
          </button>
        </p>
      )}
    </li>
  );
}

export function sortWatchRows(rows: WatchRow[], sort: WatchSort, period: WatchPeriod): WatchRow[] {
  if (sort === "added") return rows;
  const move = (row: WatchRow) => (row.changes[period] === undefined ? -1 : Math.abs(row.changes[period]!));
  const near = (row: WatchRow) => Math.abs(row.levels[0]?.distance ?? Number.POSITIVE_INFINITY);
  return [...rows].sort(sort === "move" ? (a, b) => move(b) - move(a) : (a, b) => near(a) - near(b));
}

export function WatchlistView({ data, book, locale, t, busy, onOpen, onAdd, onRemove, onNote, onSearch, onRefresh }: {
  data: WatchlistData;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onOpen: (ticker: string) => void;
  /** Resolves true once added. */
  onAdd: (ticker: string) => Promise<boolean>;
  onRemove: (ticker: string) => void;
  onNote: (ticker: string, note: string) => Promise<boolean>;
  onSearch: (query: string) => Promise<Instrument[]>;
  onRefresh: () => void;
}) {
  const [period, setPeriod] = useState<WatchPeriod>("1d");
  const [sort, setSort] = useState<WatchSort>("added");
  const rows = sortWatchRows(data.items, sort, period);
  const later = data.items.filter((row) => row.pricesMissing === "later").length;
  const listed = new Set(data.items.map((row) => row.ticker));
  const provider = data.items.find((row) => row.priceSource && row.priceSource !== "broker" && row.priceSource !== "close")?.priceSource;
  return (
    <main className="contentStack">
      <section className="dataPanel watchPanel">
        <div className="watchHeader">
          <h2>{t("watchTitle")}{data.items.length > 0 && <span className="watchCount">{data.items.length}</span>}</h2>
          {data.items.length > 0 && (
            <div className="watchControls">
              <div className="segmented" role="radiogroup" onKeyDown={radioKeys} aria-label={t("watchChangeLabel")}>
                {WATCH_PERIODS.map((key) => (
                  <button key={key} type="button" role="radio" aria-checked={period === key} tabIndex={radioTab(period === key)} aria-label={t(PERIOD_KEYS[key][1])} title={t(PERIOD_KEYS[key][1])}
                    className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>{t(PERIOD_KEYS[key][0])}</button>
                ))}
              </div>
              <div className="watchSort">
                <span aria-hidden="true">{t("watchSortLabel")}</span>
                <Select<WatchSort> value={sort} label={t("watchSortLabel")} onChange={setSort}
                  options={[{ value: "added", label: t("watchSortAdded") }, { value: "move", label: t("watchSortMove") }, { value: "level", label: t("watchSortLevel") }]} />
              </div>
            </div>
          )}
        </div>
        <InstrumentSearch label={t("watchAddLabel")} listed={listed} listedText={t("watchListed")} addText={t("watchAdd")} addLabel={(name) => fill(t("watchAddName"), { name })} busy={busy} locale={locale} t={t}
          onSearch={onSearch} onAdd={(item) => onAdd(item.ticker)} />
        {later > 0 && (
          <div className="notice warning watchLater">
            <span>{plural(later, locale, t("watchLaterOne"), t("watchLater"))}</span>
            <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={onRefresh}>{t("refresh")}</button>
          </div>
        )}
        {rows.length === 0 ? <div className="emptyState compact">{t("watchEmpty")}</div> : (
          <ul className="watchList">
            {rows.map((row) => <WatchItem key={row.ticker} row={row} period={period} book={book} locale={locale} t={t} busy={busy} onOpen={onOpen} onRemove={onRemove} onNote={onNote} />)}
          </ul>
        )}
        {rows.length > 0 && (
          <p className="panelNote">
            {provider === "sample" ? t("watchSourcesSample") : provider ? fill(t("watchSources"), { provider: quoteProviderLabel(provider, t) }) : t("watchSourcesBroker")}
          </p>
        )}
      </section>
    </main>
  );
}
