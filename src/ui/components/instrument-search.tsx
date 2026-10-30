// Search Trading 212's instruments as you type and add one: the watchlist's, and the target form's for targets not held.

import { useEffect, useId, useRef, useState, type Ref } from "react";
import type { Instrument } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import { fill, instrumentTypeLabel, plural, type Translator } from "../lib/messages";
import { SearchField } from "./common";

/** Enter in the search adds nothing and, in a form, submits nothing: a match is added with its button. */
export function holdEnter(event: { key: string; preventDefault: () => void }): void {
  if (event.key === "Enter") event.preventDefault();
}

/**
 * The best matches for a query; the ones `listed` already say so (`listedText`) instead of offering `addText`, whose
 * full name for a screen reader is `addLabel`. Enter never submits a form it sits in: a match is added with its button.
 */
export function InstrumentSearch({ label, listed, listedText, addText, addLabel, busy, locale, t, onSearch, onAdd, inputRef }: {
  label: string; listed: ReadonlySet<string>; listedText: string; addText: string; addLabel: (name: string) => string;
  /** The search box, for a caller that moves the focus to it. */
  inputRef?: Ref<HTMLInputElement>;
  busy?: boolean; locale: SupportedLocale; t: Translator;
  onSearch: (query: string) => Promise<Instrument[]>;
  /** Resolves true once added, which clears the search. */
  onAdd: (instrument: Instrument) => Promise<boolean> | boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[] | null>(null);
  const [searching, setSearching] = useState(false);
  const latest = useRef(0);
  useEffect(() => {
    const wanted = query.trim();
    const request = ++latest.current;
    if (!wanted) { setResults(null); setSearching(false); return; }
    const timer = setTimeout(() => {
      setSearching(true);
      onSearch(wanted)
        .then((found) => { if (latest.current === request) setResults(found); })
        .catch(() => { if (latest.current === request) setResults([]); })
        .finally(() => { if (latest.current === request) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const status = searching ? t("watchSearching") : results ? (results.length ? plural(results.length, locale, t("watchMatchesOne"), t("watchMatches")) : fill(t("watchNoMatch"), { query: query.trim() })) : "";
  const add = async (item: Instrument) => {
    if (await onAdd(item)) { setQuery(""); setResults(null); }
  };
  return (
    <div className="instrumentSearch">
      <label htmlFor={`${id}-q`}>{label}</label>
      <SearchField inputRef={inputRef} id={`${id}-q`} autoComplete="off" spellCheck={false} placeholder={t("watchSearchPlaceholder")} value={query}
        aria-describedby={`${id}-status`} onValue={setQuery} clearLabel={t("searchClear")} onKeyDown={holdEnter} />
      <span id={`${id}-status`} className="visuallyHidden" role="status">{status}</span>
      {results && results.length > 0 && (
        <ul className="instrumentResults">
          {results.map((item) => (
            <li key={item.ticker}>
              <span className="watchName" title={item.ticker}>
                <strong>{item.name || item.shortName}</strong>
                <small>{[item.shortName, item.currencyCode, item.type ? instrumentTypeLabel(item.type, t) : undefined].filter(Boolean).join(" · ")}</small>
              </span>
              {listed.has(item.ticker)
                ? <span className="statusPill">{listedText}</span>
                : <button type="button" className="secondaryButton compactButton" disabled={busy} aria-label={addLabel(item.name || item.shortName)}
                    onClick={() => void add(item)}>{addText}</button>}
            </li>
          ))}
        </ul>
      )}
      {results && results.length === 0 && !searching && <p className="panelNote">{fill(t("watchNoMatch"), { query: query.trim() })}</p>}
    </div>
  );
}
