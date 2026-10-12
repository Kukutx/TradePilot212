// Small, dependency-free charts. Single-series only: one hue, values always labelled,
// a native tooltip on every mark, and a table fallback so nothing relies on color alone.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { localeTag, type SupportedLocale } from "../i18n";

export interface BarDatum { key: string; label: string; value: number; display: string; sublabel?: string; title?: string }

/** Labels for the chart/table switch; the button names the view it switches to. */
export interface ChartLabels { table: string; chart: string }

export function ViewSwitch({ asTable, labels, onToggle }: { asTable: boolean; labels: ChartLabels; onToggle: () => void }) {
  return <button type="button" className="linkButton" onClick={onToggle}>{asTable ? labels.chart : labels.table}</button>;
}

/** Horizontal bars for shares of a whole (weights) or ranked amounts. */
export function BarList({ data, max, title, labels, valueHeader, nameHeader, tone }: {
  data: BarDatum[];
  max?: number;
  title: string;
  labels: ChartLabels;
  nameHeader: string;
  valueHeader: string;
  /** "signed" colours negative values and their bars red. */
  tone?: "signed";
}) {
  const [asTable, setAsTable] = useState(false);
  const top = max ?? Math.max(...data.map((item) => Math.abs(item.value)), 0);
  const valueClass = (value: number) => (tone === "signed" ? (value > 0 ? "positive" : value < 0 ? "negative" : "") : "");
  return (
    <figure className="chartFigure">
      <figcaption><span>{title}</span><ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} /></figcaption>
      {asTable ? (
        <table className="chartTable"><thead><tr><th>{nameHeader}</th><th>{valueHeader}</th></tr></thead>
          <tbody>{data.map((item) => <tr key={item.key}><td title={item.title}>{item.label}{item.sublabel && <small> · {item.sublabel}</small>}</td><td className={valueClass(item.value)}>{item.display}</td></tr>)}</tbody></table>
      ) : (
        <ul className="barList">
          {data.map((item) => (
            <li key={item.key} title={`${item.title ?? item.label}: ${item.display}`}>
              <span className="barLabel"><strong>{item.label}</strong>{item.sublabel && <small>{item.sublabel}</small>}</span>
              <span className="barTrack" aria-hidden="true"><span className={`barFill ${item.value < 0 ? "negative" : ""}`} style={{ width: `${top > 0 ? Math.max(1.5, (Math.abs(item.value) / top) * 100) : 0}%` }} /></span>
              <span className={`barValue ${valueClass(item.value)}`}>{item.display}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Vertical bars over time (e.g. monthly income). Labels only the latest and the largest bar. */
export function ColumnChart({ data, title, labels, nameHeader, valueHeader }: {
  data: BarDatum[];
  title: string;
  labels: ChartLabels;
  nameHeader: string;
  valueHeader: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const top = Math.max(...data.map((item) => item.value), 0);
  const largest = data.reduce<BarDatum | undefined>((best, item) => (!best || item.value > best.value ? item : best), undefined);
  const latest = data[data.length - 1];
  return (
    <figure className="chartFigure">
      <figcaption><span>{title}</span><ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} /></figcaption>
      {asTable ? (
        <table className="chartTable"><thead><tr><th>{nameHeader}</th><th>{valueHeader}</th></tr></thead>
          <tbody>{data.map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.display}</td></tr>)}</tbody></table>
      ) : (
        <div className="columnChart" role="img" aria-label={`${title}: ${data.map((item) => `${item.label} ${item.display}`).join(", ")}`}>
          {data.map((item) => (
            <div className="column" key={item.key} title={`${item.label}: ${item.display}`}>
              <span className="columnValue">{item === largest || item === latest ? item.display : ""}</span>
              <span className="columnBar" style={{ height: `${top > 0 ? Math.max(2, (Math.max(0, item.value) / top) * 100) : 0}%` }} />
              <span className="columnLabel">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

export interface LinePoint {
  key: string;
  label: string;
  value: number;
  display: string;
  /** When the point is from (ms). With a time on every point, gaps between points keep their real length. */
  time?: number;
}

const LINE_HEIGHT = 184;
const LINE_PAD = { top: 14, right: 14, bottom: 26, left: 60 };

/**
 * Gridline values at round steps (1, 2, 2.5 or 5 times a power of ten) inside `min`..`max`, so the axis
 * reads "0%, +10%, +20%", not "+13%": three of them where a step allows, up to five rather than only two.
 */
export function niceTicks(min: number, max: number): { ticks: number[]; step: number } {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return { ticks: [min], step: 0 };
  const base = 10 ** (Math.floor(Math.log10(span)) - 1);
  let best: { ticks: number[]; step: number; score: number } | undefined;
  for (const multiple of [1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
    const step = multiple * base;
    const first = Math.ceil(min / step - 1e-9);
    const last = Math.floor(max / step + 1e-9);
    const count = last - first + 1;
    // One gridline says nothing about scale, and two leave much of the line unmarked.
    const score = count < 2 ? 100 : count === 2 ? 2.5 : count - 3;
    if (best && score >= best.score) continue;
    const ticks = Array.from({ length: Math.max(0, count) }, (_, index) => Number(((first + index) * step).toPrecision(12)));
    best = { ticks, step, score };
  }
  return { ticks: best!.ticks, step: best!.step };
}

/** The decimals a gridline step is written with: 0 for 10 or 5, 1 for 2.5 or 0.5, 3 for 0.025, at most 4. */
export function decimalsOf(step: number): number {
  for (let digits = 0; digits < 4; digits++) if (Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits)) < 1e-6) return digits;
  return 4;
}

/** The gridlines of a chart: their values and the distance between them. */
export interface Grid { ticks: number[]; step: number }

/**
 * A gridline value in the account currency: short ("€14K", "€1.025M", "1.425万") when the short form is exact
 * for every gridline, else every one in full with the decimals the step needs, so one axis never mixes the two.
 */
export function axisMoney(value: number, grid: Grid, currency: string, locale: SupportedLocale): string {
  const short = (digits: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: digits });
  const exact = (amount: number) => short(3).format(amount) === short(8).format(amount);
  if (grid.ticks.every(exact)) return short(3).format(value);
  return new Intl.NumberFormat(localeTag(locale), { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: decimalsOf(grid.step) }).format(value);
}

/**
 * One series over time: a 2px line over a faint area, recessive gridlines at round values, the first
 * and last dates, and a crosshair with a tooltip on hover or arrow keys. A table view lists every point.
 * With `zero`, a line marks zero and the area fills between it and the series, for values that go negative.
 */
export function LineChart({ data, title, labels, nameHeader, valueHeader, axis, zero, flat = 1, belowZero, controls, compare }: {
  data: LinePoint[];
  title: string;
  labels: ChartLabels;
  nameHeader: string;
  valueHeader: string;
  /** Short form of a gridline value; `grid` holds every gridline and the step between them, for its precision. */
  axis: (value: number, grid: Grid) => string;
  zero?: boolean;
  /** How far above and below a line that never moves the scale reaches, in the chart's units: 1 by default. */
  flat?: number;
  /** The values never rise above zero, as falls from a high: a line that never moves gets a scale below zero only. */
  belowZero?: boolean;
  /** Shown in the caption beside the table switch. */
  controls?: ReactNode;
  /**
   * A second series on the same days and scale, such as a benchmark: dashed and neutral, named with the first in a
   * legend, and given beside it in the tooltip and the table. A day without a value is left out of its line.
   */
  compare?: { name: string; mainName: string; points: Array<{ value: number; display: string } | undefined> };
}) {
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width))); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);
  const values = [...data.map((item) => item.value), ...(compare?.points.flatMap((item) => (item ? [item.value] : [])) ?? [])];
  let low = Math.min(...values, ...(zero ? [0] : []));
  let high = Math.max(...values, ...(zero ? [0] : []));
  // A line that never moves: a scale either side of it, or only below zero for one that cannot rise above it.
  if (high - low < 1e-9) {
    if (belowZero && high === 0) low -= flat;
    else { low -= Math.max(flat, Math.abs(low) * 0.01); high += Math.max(flat, Math.abs(high) * 0.01); }
  }
  const grid = niceTicks(low, high);
  const span = high - low;
  low -= span * 0.08;
  high += span * 0.08;
  const plotWidth = width - LINE_PAD.left - LINE_PAD.right;
  const plotHeight = LINE_HEIGHT - LINE_PAD.top - LINE_PAD.bottom;
  // Days the server missed leave a real gap: points sit at their time, not evenly by index.
  const times = data.every((item) => typeof item.time === "number") ? data.map((item) => item.time!) : undefined;
  const timeSpan = times ? times[times.length - 1]! - times[0]! : 0;
  const position = (index: number) => data.length < 2 ? 0.5 : times && timeSpan > 0 ? (times[index]! - times[0]!) / timeSpan : index / (data.length - 1);
  const x = (index: number) => LINE_PAD.left + position(index) * plotWidth;
  const y = (value: number) => LINE_PAD.top + (1 - (value - low) / (high - low)) * plotHeight;
  const line = data.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item.value).toFixed(1)}`).join("");
  // A gap in the second series starts a new stroke rather than bridging it.
  const compareLine = compare?.points.map((item, index) => {
    if (!item) return "";
    return `${index && compare.points[index - 1] ? "L" : "M"}${x(index).toFixed(1)},${y(item.value).toFixed(1)}`;
  }).join("");
  const base = LINE_PAD.top + plotHeight;
  const floor = zero ? y(0) : base;
  const area = `${line}L${x(data.length - 1).toFixed(1)},${floor.toFixed(1)}L${x(0).toFixed(1)},${floor.toFixed(1)}Z`;
  const point = active === null ? undefined : data[active];
  const other = active === null ? undefined : compare?.points[active];
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left - LINE_PAD.left) / Math.max(1, rect.width - LINE_PAD.left - LINE_PAD.right);
    let nearest = 0;
    for (let index = 1; index < data.length; index++) if (Math.abs(position(index) - ratio) < Math.abs(position(nearest) - ratio)) nearest = index;
    setActive(nearest);
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = data.length - 1;
    setActive((current) => event.key === "Home" ? 0 : event.key === "End" ? last
      : Math.min(last, Math.max(0, (current ?? last) + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const first = data[0];
  const latest = data[data.length - 1];
  const latestOther = compare?.points[compare.points.length - 1];
  return (
    <figure className="chartFigure">
      <figcaption>
        <span>{title}</span>
        {controls ? <span className="chartControls">{controls}<ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} /></span>
          : <ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} />}
      </figcaption>
      {asTable ? (
        <table className="chartTable">
          <thead><tr><th>{nameHeader}</th><th>{compare ? compare.mainName : valueHeader}</th>{compare && <th>{compare.name}</th>}</tr></thead>
          <tbody>{data.map((item, index) => (
            <tr key={item.key}><td>{item.label}</td><td>{item.display}</td>{compare && <td>{compare.points[index]?.display ?? "—"}</td>}</tr>
          )).reverse()}</tbody>
        </table>
      ) : (
        <div className="lineChart" ref={box}>
          <svg
            width={width} height={LINE_HEIGHT} role="img" tabIndex={0}
            aria-label={`${title}: ${first?.label} ${first?.display}, ${latest?.label} ${latest?.display}${compare && latestOther ? `; ${compare.name} ${latestOther.display}` : ""}`}
            onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} onKeyDown={step} onBlur={() => setActive(null)}
          >
            {grid.ticks.map((tick) => (
              <g key={tick} className="lineGrid">
                <line x1={LINE_PAD.left} x2={width - LINE_PAD.right} y1={y(tick)} y2={y(tick)} />
                <text x={LINE_PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{axis(tick, grid)}</text>
              </g>
            ))}
            {zero && <line className="lineZero" x1={LINE_PAD.left} x2={width - LINE_PAD.right} y1={floor} y2={floor} />}
            <path className="lineArea" d={area} />
            {compareLine && <path className="lineCompare" d={compareLine} />}
            <path className="linePath" d={line} />
            <text className="lineAxis" x={x(0)} y={LINE_HEIGHT - 6} textAnchor="start">{first?.label}</text>
            {data.length > 1 && <text className="lineAxis" x={x(data.length - 1)} y={LINE_HEIGHT - 6} textAnchor="end">{latest?.label}</text>}
            {point && active !== null && (
              <g className="lineFocus">
                <line x1={x(active)} x2={x(active)} y1={LINE_PAD.top} y2={base} />
                {other && <circle className="compareDot" cx={x(active)} cy={y(other.value)} r={4} />}
                <circle cx={x(active)} cy={y(point.value)} r={5} />
              </g>
            )}
          </svg>
          {point && active !== null && (
            <div className={compare ? "lineTip withCompare" : "lineTip"} role="status" style={{ left: `${Math.min(width - (compare ? 190 : 150), Math.max(0, x(active) - (compare ? 95 : 75)))}px` }}>
              <span>{point.label}</span>
              {compare ? (
                <>
                  <span className="tipSeries"><i className="swatch main" aria-hidden="true" />{compare.mainName}<strong>{point.display}</strong></span>
                  <span className="tipSeries"><i className="swatch compare" aria-hidden="true" />{compare.name}<strong>{other?.display ?? "—"}</strong></span>
                </>
              ) : <strong>{point.display}</strong>}
            </div>
          )}
        </div>
      )}
      {compare && (
        <ul className="priceLegend lineLegend">
          <li><svg className="legendLine" width="20" height="4" aria-hidden="true"><line className="legendMain" x1="0" x2="20" y1="2" y2="2" /></svg>{compare.mainName}</li>
          <li><svg className="legendLine" width="20" height="4" aria-hidden="true"><line className="legendCompare" x1="0" x2="20" y1="2" y2="2" /></svg>{compare.name}</li>
        </ul>
      )}
    </figure>
  );
}

const SPARK = { width: 132, height: 40, pad: 5 };

/**
 * A small line of recent values beside a headline number, placed by time so missed days keep their
 * length. The caption next to it states the change in words; the label repeats it for screen readers.
 */
export function Sparkline({ points, label }: { points: Array<{ time: number; value: number }>; label: string }) {
  const { width, height, pad } = SPARK;
  const times = points.map((point) => point.time);
  const values = points.map((point) => point.value);
  const start = Math.min(...times);
  const timeSpan = Math.max(1, Math.max(...times) - start);
  const low = Math.min(...values);
  const valueSpan = Math.max(...values) - low || 1;
  const x = (time: number) => pad + ((time - start) / timeSpan) * (width - 2 * pad);
  const y = (value: number) => pad + (1 - (value - low) / valueSpan) * (height - 2 * pad);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const area = `${line}L${x(last.time).toFixed(1)},${height}L${x(first.time).toFixed(1)},${height}Z`;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path className="sparkArea" d={area} />
      <path className="sparkPath" d={line} />
      <circle className="sparkEnd" cx={x(last.time)} cy={y(last.value)} r={3.5} />
    </svg>
  );
}
