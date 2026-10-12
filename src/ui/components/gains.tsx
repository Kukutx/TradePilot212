// Where the period's gain came from: one bar per instrument from a shared zero line, gains to the right and losses to
// the left, largest gain first. A table view gives each instrument's start, trading, dividends and value now.

import { useState } from "react";
import type { GainAttribution } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { dayLabel, money, pct, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";

/** Instruments shown before "show all": the largest gains and losses, so a large loss is never the one hidden. */
const LISTED = 10;

export function GainChart({ attribution, currency, book, locale, t, onOpen, busy }: {
  attribution: GainAttribution;
  currency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  /** Open an instrument's page. */
  onOpen?: (ticker: string) => void;
  busy?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  const [all, setAll] = useState(false);
  const m = (value: number) => money(value, currency, locale);
  const signed = (value: number) => money(value, currency, locale, { signed: true });
  const { holdings } = attribution;
  const largest = new Set([...holdings].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, LISTED).map((holding) => holding.ticker));
  const shown = all ? holdings : holdings.filter((holding) => largest.has(holding.ticker));
  // The zero line sits where the largest loss and the largest gain shown, side by side, fill the track.
  const right = Math.max(0, ...shown.map((holding) => holding.gain));
  const left = Math.max(0, ...shown.map((holding) => -holding.gain));
  const span = right + left;
  const zero = span > 0 ? (left / span) * 100 : 0;
  const since = attribution.from ? fill(t("gainsSince"), { date: dayLabel(attribution.from, locale) }) : t("gainsAllHistory");
  const title = t("gainsTitle");
  const share = (value: number) => `${Math.round(Math.max(0.8, (Math.abs(value) / span) * 100) * 10) / 10}%`;
  const name = (ticker: string) => {
    const label = instrumentLabel(ticker, book);
    return onOpen
      ? <button type="button" className="inlineLink reviewName" title={ticker} aria-label={fill(t("openHolding"), { name: label.name })} disabled={busy} onClick={() => onOpen(ticker)}>{label.name}</button>
      : <strong title={ticker}>{label.name}</strong>;
  };
  const describe = (holding: GainAttribution["holdings"][number]) => [
    `${instrumentLabel(holding.ticker, book).name}: ${signed(holding.gain)}${holding.return === undefined ? "" : ` (${pct(holding.return, locale, 1, { signed: true })})`}`,
    holding.startValue ? fill(t("gainsStart"), { amount: m(holding.startValue) }) : "",
    holding.bought ? fill(t("gainsBought"), { amount: m(holding.bought) }) : "",
    holding.sold ? fill(t("gainsSold"), { amount: m(holding.sold) }) : "",
    holding.dividends ? fill(t("gainsDividends"), { amount: m(holding.dividends) }) : "",
    fill(t("gainsNow"), { amount: m(holding.value) }),
  ].filter(Boolean).join(" · ");

  return (
    <figure className="chartFigure gainChart">
      <figcaption><span>{title}</span>{holdings.length > 0 && <ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} />}</figcaption>
      <p className="gainTotal"><strong className={signedClass(attribution.total)}>{signed(attribution.total)}</strong><span>{since}</span></p>
      {holdings.length === 0 ? <div className="emptyState compact">{t("gainsNone")}</div> : asTable ? (
        <div className="gainTableWrap">
          <table className="chartTable gainTable">
            <thead><tr>
              <th>{t("symbol")}</th>{attribution.basis === "start" && <th>{t("gainsStartColumn")}</th>}<th>{t("buys")}</th><th>{t("sells")}</th><th>{t("dividends")}</th><th>{t("gainsNowColumn")}</th><th>{t("gainsColumn")}</th>
            </tr></thead>
            <tbody>{holdings.map((holding) => (
              <tr key={holding.ticker}>
                <td>{name(holding.ticker)}</td>
                {attribution.basis === "start" && <td>{m(holding.startValue)}</td>}
                <td>{m(holding.bought)}</td><td>{m(holding.sold)}</td><td>{m(holding.dividends)}</td><td>{m(holding.value)}</td>
                <td className={signedClass(holding.gain)}>{signed(holding.gain)}{holding.return === undefined ? "" : <small> {pct(holding.return, locale, 1, { signed: true })}</small>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <ul className="gainBars" aria-label={`${title}, ${since}`}>
          {shown.map((holding) => {
            const label = instrumentLabel(holding.ticker, book);
            return (
              <li key={holding.ticker} title={describe(holding)}>
                <span className="barLabel">{name(holding.ticker)}<small>{holding.return === undefined ? label.detail ?? "" : pct(holding.return, locale, 1, { signed: true })}</small></span>
                <span className="gainTrack" aria-hidden="true">
                  {left > 0 && <span className="gainZero" style={{ left: `${Math.round(zero * 10) / 10}%` }} />}
                  {holding.gain !== 0 && (
                    <span className={`gainFill ${holding.gain > 0 ? "up" : "down"}`}
                      style={holding.gain > 0 ? { left: `${Math.round(zero * 10) / 10}%`, width: share(holding.gain) } : { right: `${Math.round((100 - zero) * 10) / 10}%`, width: share(holding.gain) }} />
                  )}
                </span>
                <span className={`barValue ${signedClass(holding.gain)}`}>{signed(holding.gain)}</span>
                <span className="visuallyHidden">{describe(holding)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!asTable && holdings.length > LISTED && (
        <button type="button" className="linkButton" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t("showFewer") : fill(t("showAllCount"), { count: String(holdings.length) })}
        </button>
      )}
      {attribution.missing.length > 0 && (
        <p className="panelNote gainMissing">{fill(t("gainsMissing"), { names: attribution.missing.map((item) => instrumentLabel(item.ticker, book).name).join(", ") })}</p>
      )}
      <p className="panelNote">{t(attribution.basis === "start" ? "gainsNote" : "gainsNoteAll")}</p>
    </figure>
  );
}
