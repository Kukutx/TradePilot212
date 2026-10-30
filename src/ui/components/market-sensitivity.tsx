// How the holdings move with the market, on the Allocation tab: their beta to the benchmark together, its volatility
// and its worst week, what a 5%, 10% and 20% fall in it would take by that beta, and each holding's beta as a bar from
// 0 with a mark at 1 (moving as the market does). The bars have a table view.

import { useState } from "react";
import type { AllocationAnalysis, MarketSensitivity } from "../../shared/history";
import { marketScenarios } from "../../shared/holding-risk";
import { localeTag, type SupportedLocale } from "../i18n";
import { dayLabel, money, pct } from "../lib/format";
import { instrumentLabel, instrumentText, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";
import { Tile } from "./risk";

/** At most this many rows of bars: the highest betas. */
const MAX_ROWS = 12;
/** A beta this close to 0 says the holdings did not follow the market, either way. */
const FLAT_BETA = 0.05;

/** Where the bars' scale runs: from 0, or below it for a negative beta, to 1.5 at least, in halves. */
export function betaScale(rows: MarketSensitivity["rows"]): { low: number; high: number } {
  const betas = rows.map((row) => row.beta);
  return { low: Math.min(0, Math.floor(Math.min(...betas, 0) * 2) / 2), high: Math.max(1.5, Math.ceil(Math.max(...betas, 0) * 2) / 2) };
}

export function MarketSensitivityPanel({ market, data, book, locale, t }: {
  market: MarketSensitivity;
  data: Pick<AllocationAnalysis, "accountCurrency" | "totalValue"> & { risk?: Pick<NonNullable<AllocationAnalysis["risk"]>, "mix"> };
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
}) {
  const [asTable, setAsTable] = useState(false);
  const benchmarkLabel = instrumentLabel(market.ticker, book);
  const benchmark = benchmarkLabel.detail || benchmarkLabel.name;
  const signed = (value: number, digits = 1) => pct(value, locale, digits, { signed: true });
  // Betas and correlations to two decimals, as "1.20" and "0.85", so a column of them lines up.
  const fixed = (value: number, digits = 2) => new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const beta = (value: number) => fixed(value);
  const value = data.risk?.mix?.value;
  const scenarios = value ? marketScenarios(market.beta, value, data.totalValue) : [];
  const rows = market.rows.slice(0, MAX_ROWS);
  const { low, high } = betaScale(rows);
  const at = (point: number) => `${((point - low) / (high - low)) * 100}%`;
  const span = (row: MarketSensitivity["rows"][number]) => ({ left: at(Math.min(0, row.beta)), width: `${(Math.abs(row.beta) / (high - low)) * 100}%` });
  const rowTitle = (row: MarketSensitivity["rows"][number]) => fill(t("marketRowTitle"), {
    name: instrumentText(row.ticker, book), beta: beta(row.beta), correlation: fixed(row.correlation), weight: pct(row.weight, locale, 0),
  });
  const worst = market.worstWeek;
  return (
    <section className="dataPanel marketSensitivity">
      <figure className="chartFigure">
        <figcaption><span>{t("marketTitle")}</span><ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} /></figcaption>
        <div className="riskGrid">
          <Tile label={fill(t("marketBeta"), { benchmark })} value={beta(market.beta)}
            sub={fill(t(market.beta > FLAT_BETA ? "marketBetaSub" : market.beta < -FLAT_BETA ? "marketBetaAgainstSub" : "marketBetaFlatSub"), { times: fixed(Math.abs(market.beta)), correlation: fixed(market.correlation) })} />
          <Tile label={fill(t("marketVolatility"), { benchmark })} value={pct(market.volatility, locale, 1)}
            sub={fill(t("marketVolatilitySub"), { weeks: String(market.weeks), date: dayLabel(market.to, locale) })} />
          {worst && <Tile label={fill(t("marketWorst"), { benchmark })} value={signed(worst.market)} tone={worst.market < 0 ? "negative" : undefined}
            sub={worst.mix === undefined ? fill(t("marketWorstDateSub"), { date: dayLabel(worst.date, locale) }) : fill(t("marketWorstSub"), { date: dayLabel(worst.date, locale), mix: signed(worst.mix) })} />}
        </div>
        {scenarios.length > 0 && (
          <div className="marketFalls">
            <h3>{fill(t("marketFalls"), { benchmark })}</h3>
            <ul>
              {scenarios.map((scenario) => {
                const amount = money(scenario.amount, data.accountCurrency, locale, { digits: 0 });
                const title = fill(t("marketFallTitle"), { benchmark, fall: pct(-scenario.market, locale, 0), move: signed(scenario.move), amount });
                return (
                  <li key={scenario.market} title={title}>
                    <span>{fill(t("marketFall"), { benchmark, move: signed(scenario.market, 0) })}</span>
                    <strong className={scenario.move < 0 ? "negative" : scenario.move > 0 ? "positive" : undefined}>{signed(scenario.move)}</strong>
                    <small>{fill(t("marketFallAmount"), { amount })}{scenario.account !== undefined && <> · {fill(t("marketFallAccount"), { share: signed(scenario.account) })}</>}</small>
                    <span className="visuallyHidden">{title}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {asTable ? (
          <table className="chartTable">
            <thead><tr><th>{t("symbol")}</th><th>{t("marketBetaColumn")}</th><th>{t("holdingRiskCorrelationColumn")}</th><th>{t("holdingRiskShareValue")}</th></tr></thead>
            <tbody>{market.rows.map((row) => (
              <tr key={row.ticker}><td title={row.ticker}>{instrumentText(row.ticker, book)}</td><td>{beta(row.beta)}</td><td>{fixed(row.correlation)}</td><td>{pct(row.weight, locale, 0)}</td></tr>
            ))}</tbody>
          </table>
        ) : (
          <>
            <div className="riskShareLegend" aria-hidden="true">
              <span><i className="riskSwatch risk" />{t("marketBetaColumn")}</span>
              <span><i className="betaOneSwatch" />{t("marketOne")}</span>
            </div>
            <ul className="betaList">
              {rows.map((row) => {
                const label = instrumentLabel(row.ticker, book);
                return (
                  <li key={row.ticker} title={rowTitle(row)}>
                    <span className="barLabel" aria-hidden="true"><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</span>
                    <span className="betaTrack" aria-hidden="true">
                      {low < 0 && <i className="betaZero" style={{ left: at(0) }} />}
                      <span className={`betaFill${row.beta < 0 ? " against" : ""}`} style={span(row)} />
                      <i className="betaOne" style={{ left: at(1) }} />
                    </span>
                    <span className="riskShareValues" aria-hidden="true"><strong>{beta(row.beta)}</strong><small>{pct(row.weight, locale, 0)}</small></span>
                    <span className="visuallyHidden">{rowTitle(row)}</span>
                  </li>
                );
              })}
            </ul>
            {market.rows.length > MAX_ROWS && <p className="panelNote">{fill(t("holdingRiskMore"), { count: String(market.rows.length - MAX_ROWS) })}</p>}
          </>
        )}
        <p className="panelNote">{fill(t("marketNote"), { benchmark })}</p>
      </figure>
    </section>
  );
}
