// How much the time-weighted return moved from day to day: its volatility, its best and worst days and how it moved
// with the benchmark, then a chart of how many days it moved by how much. Rises are green and falls red, as on the
// holdings map, and every bar has its range and count in its hover text and the table view.

import { useState } from "react";
import type { BenchmarkReturn, DailyMove, TimeWeightedReturn } from "../../shared/history";
import { dailyMoves } from "../../shared/risk";
import type { SupportedLocale } from "../i18n";
import { dayLabel, num, pct } from "../lib/format";
import { fill, plural, sentences, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";

/** Bar widths to choose from: the smallest that keeps the chart to 16 bars (the widest caps it there). */
const BIN_WIDTHS = [0.0025, 0.005, 0.01, 0.02, 0.05, 0.1];
const MAX_BINS = 16;

export interface MoveBin {
  /** From (inclusive) and to (exclusive), as fractions; a bar never straddles 0. */
  from: number;
  to: number;
  count: number;
  /** The last bar of a chart capped at 16 also holds every larger rise. */
  over?: true;
}

/** The daily moves counted into bars of one width, from the bar holding the largest fall to the one holding the largest rise. */
export function moveBins(moves: DailyMove[]): { width: number; bins: MoveBin[] } | undefined {
  if (!moves.length) return undefined;
  const low = Math.min(...moves.map((move) => move.return));
  const high = Math.max(...moves.map((move) => move.return));
  const indexOf = (value: number, width: number) => Math.floor(value / width + 1e-9);
  const width = BIN_WIDTHS.find((step) => indexOf(high, step) - indexOf(low, step) + 1 <= MAX_BINS) ?? BIN_WIDTHS[BIN_WIDTHS.length - 1]!;
  const first = indexOf(low, width);
  // Falls stop at -100%, so only a rise can run past 16 bars of the widest (a glitch): the last bar takes it.
  const last = Math.min(indexOf(high, width), first + MAX_BINS - 1);
  const bins: MoveBin[] = Array.from({ length: last - first + 1 }, (_, offset) => ({ from: (first + offset) * width, to: (first + offset + 1) * width, count: 0 }));
  for (const move of moves) bins[Math.min(indexOf(move.return, width), last) - first]!.count++;
  if (indexOf(high, width) > last) bins[bins.length - 1]!.over = true;
  return { width, bins };
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="riskTile">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function RiskPanel({ returns, benchmark, locale, t }: { returns: TimeWeightedReturn; benchmark?: BenchmarkReturn; locale: SupportedLocale; t: Translator }) {
  const [asTable, setAsTable] = useState(false);
  const risk = returns.risk;
  if (!risk) return null;
  const bench = benchmark?.risk;
  const name = benchmark ? benchmark.shortName ?? benchmark.ticker : "";
  const moved = risk.up + risk.down;
  const histogram = moveBins(dailyMoves(returns.series, risk.to));
  const digits = histogram && histogram.width < 0.01 ? 2 : 0;
  const edge = (value: number) => pct(Math.abs(value) < 1e-9 ? 0 : value, locale, digits, { signed: true });
  const range = (bin: MoveBin) => (bin.over ? fill(t("riskMovesOver"), { from: edge(bin.from) }) : `${edge(bin.from)} – ${edge(bin.to)}`);
  const binTitle = (bin: MoveBin) => plural(bin.count, locale, t("riskMovesBinOne"), t("riskMovesBin"), { range: range(bin) });
  const top = histogram ? Math.max(...histogram.bins.map((bin) => bin.count)) : 0;
  const most = histogram?.bins.find((bin) => bin.count === top);
  // Where 0 falls along the bars, for its label: away from the ends, whose labels it would run into.
  const zeroAt = histogram ? histogram.bins.findIndex((bin) => Math.abs(bin.from) < 1e-9) / histogram.bins.length : -1;
  const lastBin = histogram?.bins[histogram.bins.length - 1];
  const highEnd = lastBin ? (lastBin.over ? range(lastBin) : edge(lastBin.to)) : "";
  const day = (move: DailyMove) => dayLabel(move.date, locale, { year: false });
  return (
    <figure className="chartFigure riskPanel">
      <figcaption><span>{t("riskTitle")}</span>{histogram && <ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} />}</figcaption>
      <div className="riskGrid">
        <Tile label={t("riskVolatility")} value={pct(risk.volatility, locale, 1)} {...(bench ? { sub: fill(t("riskVolatilityBench"), { name, value: pct(bench.volatility, locale, 1) }) } : {})} />
        {risk.ratio !== undefined && risk.annualized !== undefined && (
          <Tile label={t("riskRatio")} value={num(risk.ratio, locale, 2)} sub={fill(t("riskRatioSub"), { value: pct(risk.annualized, locale, 1, { signed: true }) })} />
        )}
        {bench?.beta !== undefined && <Tile label={fill(t("riskBeta"), { name })} value={num(bench.beta, locale, 2)} {...(bench.correlation !== undefined ? { sub: fill(t("riskCorrelation"), { value: num(bench.correlation, locale, 2) }) } : {})} />}
        {risk.best && <Tile label={t("riskBest")} value={pct(risk.best.return, locale, 2, { signed: true })} sub={day(risk.best)} tone="positive" />}
        {risk.worst && <Tile label={t("riskWorst")} value={pct(risk.worst.return, locale, 2, { signed: true })} sub={day(risk.worst)} tone="negative" />}
        {moved > 0 && <Tile label={t("riskUpDays")} value={fill(t("riskUpDaysValue"), { up: String(risk.up), total: String(moved) })} sub={fill(t("riskUpDaysSub"), { share: pct(risk.up / moved, locale, 0) })} />}
      </div>
      {histogram && (
        <div className="riskMoves">
          <h3>{t("riskMovesTitle")}</h3>
          {asTable ? (
            <table className="chartTable"><thead><tr><th>{t("riskMovesRange")}</th><th>{t("riskMovesDays")}</th></tr></thead>
              <tbody>{histogram.bins.map((bin) => <tr key={bin.from}><td>{range(bin)}</td><td>{bin.count}</td></tr>)}</tbody></table>
          ) : (
            <>
              <div className="moveChart" role="img" aria-label={plural(moved, locale, t("riskMovesSummaryOne"), t("riskMovesSummary"), { low: edge(histogram.bins[0]!.from), high: highEnd, most: most ? range(most) : "" })}>
                {histogram.bins.map((bin) => (
                  <div key={bin.from} className={`moveColumn ${bin.from < 0 ? "down" : "up"}`} title={binTitle(bin)}>
                    {bin === most && <span className="moveCount">{bin.count}</span>}
                    <span className="moveBar" style={{ height: `${top > 0 ? (bin.count / top) * 100 : 0}%` }} />
                  </div>
                ))}
              </div>
              <div className="moveAxis" aria-hidden="true">
                <span>{edge(histogram.bins[0]!.from)}</span>
                {zeroAt >= 0.15 && zeroAt <= 0.85 && <span className="moveZero" style={{ left: `${zeroAt * 100}%` }}>{edge(0)}</span>}
                <span>{highEnd}</span>
              </div>
            </>
          )}
        </div>
      )}
      <p className="panelNote">{sentences(locale, [t("riskNote"), risk.ratio !== undefined ? t("riskNoteRatio") : risk.annualized === undefined && t("riskNoteNoRatio"), bench && fill(t(bench.beta !== undefined ? "riskNoteBenchmark" : "riskNoteNoBeta"), { name })])}</p>
    </figure>
  );
}
