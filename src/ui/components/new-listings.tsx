// The instruments Trading 212 added lately, under the watchlist: read when asked (one instrument-list read, which the
// server keeps ten minutes), by window and type, each one openable and addable to the watchlist.

import { useEffect, useRef, useState } from "react";
import { LISTING_WINDOWS, type ListingWatch, type NewListing, type NewListingsView } from "../../shared/listings";
import type { SupportedLocale } from "../i18n";
import { dayLabel } from "../lib/format";
import { fill, instrumentTypeLabel, plural, type Translator } from "../lib/messages";
import { radioKeys, radioTab, radioTabOf } from "../lib/radio";
import { AssetAvatar } from "./common";

export interface ListingRead { days: number; type?: string; currency?: string }

/** The types in the window, most first, with how many of each. */
export function listingTypes(types: Record<string, number>): Array<[string, number]> {
  return Object.entries(types).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** "Added today", "yesterday", or the day, counted in the viewer's own days. */
export function addedText(addedOn: string, now: Date, locale: SupportedLocale, t: Translator): string {
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const ago = Math.round((day(now) - day(new Date(addedOn))) / 86_400_000);
  if (ago <= 0) return t("listingsToday");
  if (ago === 1) return t("listingsYesterday");
  return fill(t("listingsAdded"), { date: dayLabel(addedOn, locale, { year: new Date(addedOn).getFullYear() !== now.getFullYear() }) });
}

function ListingRow({ item, listed, busy, now, locale, t, onOpen, onAdd }: {
  item: NewListing; listed: boolean; busy: boolean; now: Date; locale: SupportedLocale; t: Translator;
  onOpen: (ticker: string) => void; onAdd: (ticker: string) => Promise<boolean>;
}) {
  const added = addedText(item.addedOn, now, locale, t);
  const detail = [item.shortName, item.type ? instrumentTypeLabel(item.type, t) : undefined, item.currencyCode].filter(Boolean).join(" · ");
  return (
    <li className="listingRow">
      <button type="button" className="listingMain" disabled={busy} title={item.ticker} onClick={() => onOpen(item.ticker)}
        aria-label={fill(t("listingsOpen"), { name: item.name, added })}>
        <AssetAvatar ticker={item.ticker} label={{ name: item.name, detail }} />
        <span className="watchName"><strong>{item.name}</strong><small>{detail}</small></span>
        <span className="listingAdded">{added}</span>
      </button>
      {listed
        ? <span className="statusPill">{t("watchListed")}</span>
        : <button type="button" className="secondaryButton compactButton" disabled={busy} aria-label={fill(t("watchAddName"), { name: item.name })}
            onClick={() => void onAdd(item.ticker)}>{t("watchAdd")}</button>}
    </li>
  );
}

/** What a listing alert or the panel's filter covers, in words: "ETFs · USD", or any instrument. */
export function watchScope(types: string[], currencies: string[], t: Translator): string {
  const parts = [types.map((type) => instrumentTypeLabel(type, t)).join(" / "), currencies.join(" / ")].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("listingsAlertAny");
}

const sameCodes = (a: string[], b: string[]) => a.length === b.length && a.every((code, index) => code === b[index]);

/** Turn the account's listing alert on for what the panel shows, change it to that, or turn it off. */
function ListingAlert({ data, busy, t, onWatch }: {
  data: NewListingsView; busy: boolean; t: Translator;
  onWatch: (scope: { types: string[]; currencies: string[] } | null) => Promise<ListingWatch | null>;
}) {
  const [watch, setWatch] = useState<ListingWatch | null>(data.watch ?? null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setWatch(data.watch ?? null), [data.watch]);
  const wanted = { types: data.type ? [data.type] : [], currencies: data.currency ? [data.currency] : [] };
  const shown = watchScope(wanted.types, wanted.currencies, t);
  const save = async (scope: typeof wanted | null) => {
    setSaving(true);
    setFailed(false);
    try {
      setWatch(await onWatch(scope));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const disabled = busy || saving;
  const differs = watch && !(sameCodes(watch.types, wanted.types) && sameCodes(watch.currencies, wanted.currencies));
  return (
    <div className="listingsAlert" role="group" aria-label={t("listingsAlertLabel")}>
      <div className="listingsAlertText">
        <strong>{watch ? fill(t("listingsAlertOn"), { scope: watchScope(watch.types, watch.currencies, t) }) : t("listingsAlertOff")}</strong>
        <small>{watch ? (data.webhook ? t("listingsAlertHow") : t("listingsAlertLogged")) : fill(t("listingsAlertOffer"), { scope: shown })}</small>
        {failed && <span className="fieldError" role="alert">{t("listingsAlertFailed")}</span>}
      </div>
      <div className="listingsAlertActions">
        {watch && differs && (
          <button type="button" className="secondaryButton compactButton" disabled={disabled} onClick={() => void save(wanted)}>{fill(t("listingsAlertChange"), { scope: shown })}</button>
        )}
        {watch
          ? <button type="button" className="secondaryButton compactButton" disabled={disabled} onClick={() => void save(null)}>{t("listingsAlertStop")}</button>
          : <button type="button" className="primaryButton compactButton" disabled={disabled} onClick={() => void save(wanted)}>{t("listingsAlertStart")}</button>}
      </div>
    </div>
  );
}

export function NewListingsPanel({ initial, listed, busy, locale, t, onRead, onOpen, onAdd, onWatch }: {
  /** A read the host made, shown as it is. */
  initial?: NewListingsView | undefined;
  listed: ReadonlySet<string>;
  busy: boolean;
  locale: SupportedLocale;
  t: Translator;
  onRead: (read: ListingRead) => Promise<NewListingsView>;
  onOpen: (ticker: string) => void;
  onAdd: (ticker: string) => Promise<boolean>;
  /** Turn the listing alert on for a scope, or off (null); resolves to the alert as saved. */
  onWatch: (scope: { types: string[]; currencies: string[] } | null) => Promise<ListingWatch | null>;
}) {
  const [data, setData] = useState<NewListingsView | undefined>(initial);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState<ListingRead | null>(null);
  const latest = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!initial) return;
    setData(initial);
    setFailed(null);
    panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [initial]);

  const read = async (wanted: ListingRead) => {
    const request = ++latest.current;
    setReading(true);
    setFailed(null);
    try {
      const next = await onRead(wanted);
      if (latest.current === request) setData(next);
    } catch {
      if (latest.current === request) setFailed(wanted);
    } finally {
      if (latest.current === request) setReading(false);
    }
  };
  const asked = (change: Partial<ListingRead>): ListingRead => {
    const base: ListingRead = { days: data?.days ?? 30, ...(data?.type ? { type: data.type } : {}), ...(data?.currency ? { currency: data.currency } : {}) };
    const next = { ...base, ...change };
    if (!next.type) delete next.type;
    if (!next.currency) delete next.currency;
    return next;
  };
  const disabled = busy || reading;
  const now = data ? new Date(data.timestamp) : new Date();
  const types = data ? listingTypes(data.types) : [];
  // A chosen type the window has none of keeps its chip, so it can still be cleared.
  const typeKeys = [null, ...types.map(([type]) => type), ...(data?.type && !data.types[data.type] ? [data.type] : [])];
  const total = types.reduce((sum, [, count]) => sum + count, 0);
  const windows: number[] = [...LISTING_WINDOWS];

  return (
    <section ref={panel} className="dataPanel listingsPanel" aria-busy={reading || undefined} aria-labelledby="listings-title">
      <div className="watchHeader">
        <h2 id="listings-title">{t("listingsTitle")}{data && data.total > 0 && <span className="watchCount">{data.total}</span>}</h2>
        {data && (
          <div className="segmented" role="radiogroup" onKeyDown={radioKeys} aria-label={t("listingsWindow")}>
            {windows.map((days) => (
              <button key={days} type="button" role="radio" aria-checked={data.days === days} tabIndex={radioTabOf(windows, windows.includes(data.days) ? data.days : null, days)}
                className={data.days === days ? "active" : ""} disabled={disabled} onClick={() => { if (data.days !== days) void read(asked({ days })); }}>
                {fill(t("listingsDays"), { count: String(days) })}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="panelNote listingsIntro">{t("listingsIntro")}</p>
      {!data && !failed && (
        <button type="button" className="secondaryButton" disabled={disabled} onClick={() => void read({ days: 30 })}>
          {reading ? t("listingsReading") : t("listingsShow")}
        </button>
      )}
      {failed && (
        <div className="notice warning listingsFailed" role="alert">
          <span>{t("listingsFailed")}</span>
          <button type="button" className="secondaryButton compactButton" disabled={disabled} onClick={() => void read(failed)}>{t("retry")}</button>
        </div>
      )}
      {data && (
        <>
          {(types.length > 1 || data.type) && (
            <div className="filterChips" role="radiogroup" onKeyDown={radioKeys} aria-label={t("listingsType")}>
              {typeKeys.map((type) => {
                const checked = (data.type ?? null) === type;
                return (
                  <button key={type ?? "all"} type="button" role="radio" aria-checked={checked} tabIndex={radioTab(checked)} className={checked ? "active" : ""} disabled={disabled}
                    onClick={() => { if (!checked) void read(asked({ type: type ?? undefined })); }}>
                    {type === null ? `${t("historyAll")} ${total}` : `${instrumentTypeLabel(type, t)} ${data.types[type] ?? 0}`}
                  </button>
                );
              })}
            </div>
          )}
          {data.currency && (
            <div className="listingsCurrency">
              <span>{fill(t("listingsCurrency"), { currency: data.currency })}</span>
              <button type="button" className="secondaryButton compactButton" disabled={disabled} onClick={() => void read(asked({ currency: undefined }))}>{t("listingsAllCurrencies")}</button>
            </div>
          )}
          {data.listings.length === 0
            ? <div className="emptyState compact">{fill(t("listingsNone"), { count: String(data.days) })}</div>
            : (
              <ul className="listingList">
                {data.listings.map((item) => (
                  <ListingRow key={item.ticker} item={item} listed={listed.has(item.ticker)} busy={disabled} now={now} locale={locale} t={t} onOpen={onOpen} onAdd={onAdd} />
                ))}
              </ul>
            )}
          {data.total > data.listings.length && <p className="panelNote">{fill(t("listingsShown"), { shown: String(data.listings.length), total: String(data.total) })}</p>}
          {data.undated > 0 && <p className="panelNote">{plural(data.undated, locale, t("listingsUndatedOne"), t("listingsUndated"))}</p>}
          <ListingAlert data={data} busy={disabled} t={t} onWatch={onWatch} />
        </>
      )}
    </section>
  );
}
