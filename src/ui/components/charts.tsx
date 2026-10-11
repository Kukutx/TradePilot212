// Small, dependency-free charts. Single-series only: one hue, values always labelled,
// a native tooltip on every mark, and a table fallback so nothing relies on color alone.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface BarDatum { key: string; label: string; value: number; display: string; sublabel?: string; title?: string }

/** Labels for the chart/table switch; the button names the view it switches to. */
export interface ChartLabels { table: string; chart: string }

function ViewSwitch({ asTable, labels, onToggle }: { asTable: boolean; labels: ChartLabels; onToggle: () => void }) {
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
 * One series over time: a 2px line over a faint area, three recessive gridlines with values, the first
 * and last dates, and a crosshair with a tooltip on hover or arrow keys. A table view lists every point.
 */
export function LineChart({ data, title, labels, nameHeader, valueHeader, axis }: {
  data: LinePoint[];
  title: string;
  labels: ChartLabels;
  nameHeader: string;
  valueHeader: string;
  /** Short form of a value for the axis. */
  axis: (value: number) => string;
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
  const values = data.map((item) => item.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-9) { low -= Math.max(1, Math.abs(low) * 0.01); high += Math.max(1, Math.abs(high) * 0.01); }
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
  const base = LINE_PAD.top + plotHeight;
  const area = `${line}L${x(data.length - 1).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z`;
  const ticks = [high - span * 0.08, (high + low) / 2, low + span * 0.08];
  const point = active === null ? undefined : data[active];
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
  return (
    <figure className="chartFigure">
      <figcaption><span>{title}</span><ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} /></figcaption>
      {asTable ? (
        <table className="chartTable"><thead><tr><th>{nameHeader}</th><th>{valueHeader}</th></tr></thead>
          <tbody>{[...data].reverse().map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.display}</td></tr>)}</tbody></table>
      ) : (
        <div className="lineChart" ref={box}>
          <svg
            width={width} height={LINE_HEIGHT} role="img" tabIndex={0}
            aria-label={`${title}: ${first?.label} ${first?.display}, ${latest?.label} ${latest?.display}`}
            onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} onKeyDown={step} onBlur={() => setActive(null)}
          >
            {ticks.map((tick) => (
              <g key={tick} className="lineGrid">
                <line x1={LINE_PAD.left} x2={width - LINE_PAD.right} y1={y(tick)} y2={y(tick)} />
                <text x={LINE_PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{axis(tick)}</text>
              </g>
            ))}
            <path className="lineArea" d={area} />
            <path className="linePath" d={line} />
            <text className="lineAxis" x={x(0)} y={LINE_HEIGHT - 6} textAnchor="start">{first?.label}</text>
            {data.length > 1 && <text className="lineAxis" x={x(data.length - 1)} y={LINE_HEIGHT - 6} textAnchor="end">{latest?.label}</text>}
            {point && active !== null && (
              <g className="lineFocus">
                <line x1={x(active)} x2={x(active)} y1={LINE_PAD.top} y2={base} />
                <circle cx={x(active)} cy={y(point.value)} r={5} />
              </g>
            )}
          </svg>
          {point && active !== null && (
            <div className="lineTip" role="status" style={{ left: `${Math.min(width - 150, Math.max(0, x(active) - 75))}px` }}>
              <span>{point.label}</span><strong>{point.display}</strong>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
