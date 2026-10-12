// Risk by holding, on the Allocation tab: each holding's share of the holdings' risk beside its share of their value,
// from a year of weekly closes, then how the largest move with each other. A holding with a longer risk bar than value
// bar swings more than its weight says. The correlations are a grid tinted blue below 0 and amber above it, through a
// neutral 0, each cell with its value written in it; the bars have a table view.

import { useState } from "react";
import type { AllocationAnalysis, HoldingRisk } from "../../shared/history";
import { localeTag, type SupportedLocale } from "../i18n";
import { dayLabel, num, pct } from "../lib/format";
import { instrumentLabel, instrumentText, type InstrumentBook } from "../lib/instruments";
import { fill, sentences, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";

/** At most this many rows of bars: the largest shares of the risk. */
const MAX_ROWS = 12;
/** At most this many holdings are named in a note. */
const MAX_NAMED = 8;

/** A correlation to two decimals, as every cell and title shows it: "0.60", "-0.15". */
const correlationNumber = (value: number, locale: SupportedLocale) =>
  new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

/** A correlation as it fits a small cell: ".62", ".60", "−.15", "1". */
export function correlationText(value: number, locale: SupportedLocale): string {
  if (Math.abs(value) >= 0.995) return value > 0 ? "1" : "−1";
  const text = correlationNumber(Math.abs(value), locale).replace(/^0(?=[.,])/, "");
  return value <= -0.005 ? `−${text}` : text;
}

/** The cell's tint: amber for moving together, blue for moving apart, the panel's own colour at 0 (the stylesheet mixes them). */
export function correlationTint(value: number): { className: string; style: Record<string, string> } {
  return { className: value >= 0 ? "together" : "apart", style: { "--corr": String(Math.round(Math.min(1, Math.abs(value)) * 100) / 100) } };
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="riskTile">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Correlations({ risk, book, locale, t }: { risk: HoldingRisk; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const { tickers, matrix } = risk.correlations;
  const short = (ticker: string) => { const label = instrumentLabel(ticker, book); return label.detail || label.name; };
  return (
    <div className="corrBlock">
      <h3>{t("holdingRiskCorrelations")}</h3>
      <div className="corrScroll">
        <table className="corrTable">
          <thead>
            <tr><td />{tickers.map((ticker) => <th key={ticker} scope="col" title={instrumentText(ticker, book)}>{short(ticker)}</th>)}</tr>
          </thead>
          <tbody>
            {tickers.map((row, i) => (
              <tr key={row}>
                <th scope="row" title={instrumentText(row, book)}>{short(row)}</th>
                {tickers.map((column, j) => {
                  const value = matrix[i]![j]!;
                  const title = fill(t("holdingRiskCell"), { a: instrumentText(row, book), b: instrumentText(column, book), value: correlationNumber(value, locale) });
                  if (i === j) return <td key={column} className="corrSelf" title={title}>·</td>;
                  const tint = correlationTint(value);
                  return <td key={column} title={title} className={tint.className} style={tint.style}>{correlationText(value, locale)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="corrLegend" aria-hidden="true">
        <span>−1</span><span className="corrScale" /><span>1</span>
      </div>
      <p className="panelNote">{t("holdingRiskCorrelationNote")}</p>
    </div>
  );
}

export function HoldingRiskPanel({ data, book, locale, t }: { data: Pick<AllocationAnalysis, "risk" | "riskMissing" | "holdings">; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const [asTable, setAsTable] = useState(false);
  const { risk } = data;
  if (data.holdings.filter((holding) => holding.value > 0).length < 2) return null;
  const later = data.riskMissing?.some((item) => item.reason === "later");
  // The holdings a note names, by name, the first few of a long list.
  const named = (tickers: string[]) => {
    const list = tickers.slice(0, MAX_NAMED).map((ticker) => instrumentText(ticker, book)).join(locale === "zh-CN" ? "、" : ", ");
    return tickers.length > MAX_NAMED ? fill(t("holdingRiskAndMore"), { list, count: String(tickers.length - MAX_NAMED) }) : list;
  };
  const unread = data.riskMissing?.filter((item) => item.reason !== "later").map((item) => item.ticker) ?? [];
  const short = risk?.short ?? [];
  const jumps = risk?.jumps ?? [];
  const notes = sentences(locale, [
    risk && t("holdingRiskNote"),
    risk?.rows.some((row) => row.risk < 0) && t("holdingRiskOffset"),
    risk && risk.covered < 0.995 && fill(t("holdingRiskCovered"), { share: pct(risk.covered, locale, 0) }),
    unread.length > 0 && fill(t("holdingRiskMissing"), { list: named(unread) }),
    short.length > 0 && fill(t("holdingRiskShort"), { list: named(short) }),
    jumps.length > 0 && fill(t("holdingRiskJumps"), { list: named(jumps) }),
    later && t("holdingRiskLater"),
  ]);
  if (!risk) {
    return (
      <section className="dataPanel holdingRisk">
        <figure className="chartFigure">
          <figcaption><span>{t("holdingRiskTitle")}</span></figcaption>
          <p className="emptyState compact">{t("holdingRiskNone")}</p>
          {notes && <p className="panelNote">{notes}</p>}
        </figure>
      </section>
    );
  }
  const rows = risk.rows.slice(0, MAX_ROWS);
  // A share below 0 (a holding that offsets the rest) is drawn as long as its size, hatched.
  const top = Math.max(...rows.map((row) => Math.max(Math.abs(row.risk), row.weight)), 0);
  const width = (value: number) => `${top > 0 ? (Math.abs(value) / top) * 100 : 0}%`;
  const largest = risk.rows[0]!;
  // The ticker beside its share keeps the share in sight; the name, however long, wraps below it.
  const largestLabel = instrumentLabel(largest.ticker, book);
  const share = (value: number) => pct(value, locale, 0);
  const rowTitle = (row: HoldingRisk["rows"][number]) => fill(t("holdingRiskRowTitle"), {
    name: instrumentText(row.ticker, book), risk: share(row.risk), weight: share(row.weight), volatility: pct(row.volatility, locale, 0), correlation: correlationNumber(row.correlation, locale),
  });
  return (
    <section className="dataPanel holdingRisk">
      <figure className="chartFigure">
        <figcaption><span>{t("holdingRiskTitle")}</span><ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} /></figcaption>
        <div className="riskGrid">
          <Tile label={t("holdingRiskVolatility")} value={pct(risk.volatility, locale, 1)} sub={fill(t("holdingRiskVolatilitySub"), { weeks: String(risk.weeks), date: dayLabel(risk.to, locale) })} />
          <Tile label={t("holdingRiskDiversification")} value={num(risk.diversification, locale, 2)} sub={t("holdingRiskDiversificationSub")} />
          <Tile label={t("holdingRiskLargest")} value={`${largestLabel.detail || largestLabel.name} · ${share(largest.risk)}`} sub={largestLabel.detail
            ? fill(t("holdingRiskLargestNamed"), { name: largestLabel.name, weight: share(largest.weight) })
            : fill(t("holdingRiskLargestSub"), { weight: share(largest.weight) })} />
        </div>
        {asTable ? (
          <table className="chartTable riskShareTable">
            <thead><tr><th>{t("symbol")}</th><th>{t("holdingRiskShareRisk")}</th><th>{t("holdingRiskShareValue")}</th><th>{t("holdingRiskVolatilityColumn")}</th><th>{t("holdingRiskCorrelationColumn")}</th></tr></thead>
            <tbody>{risk.rows.map((row) => (
              <tr key={row.ticker}><td title={row.ticker}>{instrumentText(row.ticker, book)}</td><td>{share(row.risk)}</td><td>{share(row.weight)}</td><td>{pct(row.volatility, locale, 0)}</td><td>{correlationNumber(row.correlation, locale)}</td></tr>
            ))}</tbody>
          </table>
        ) : (
          <>
            <div className="riskShareLegend" aria-hidden="true">
              <span><i className="riskSwatch risk" />{t("holdingRiskShareRisk")}</span>
              <span><i className="riskSwatch value" />{t("holdingRiskShareValue")}</span>
            </div>
            <ul className="riskShareList">
              {rows.map((row) => {
                const label = instrumentLabel(row.ticker, book);
                return (
                  <li key={row.ticker} title={rowTitle(row)}>
                    <span className="barLabel" aria-hidden="true"><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</span>
                    <span className="riskShareBars" aria-hidden="true">
                      <span className="riskShareTrack"><span className={`riskShareFill risk${row.risk < 0 ? " offset" : ""}`} style={{ width: width(row.risk) }} /></span>
                      <span className="riskShareTrack thin"><span className="riskShareFill value" style={{ width: width(row.weight) }} /></span>
                    </span>
                    <span className="riskShareValues" aria-hidden="true"><strong>{share(row.risk)}</strong><small>{share(row.weight)}</small></span>
                    <span className="visuallyHidden">{rowTitle(row)}</span>
                  </li>
                );
              })}
            </ul>
            {risk.rows.length > MAX_ROWS && <p className="panelNote">{fill(t("holdingRiskMore"), { count: String(risk.rows.length - MAX_ROWS) })}</p>}
          </>
        )}
        {risk.correlations.tickers.length >= 3 && <Correlations risk={risk} {...(book ? { book } : {})} locale={locale} t={t} />}
        <p className="panelNote">{notes}</p>
      </figure>
    </section>
  );
}
