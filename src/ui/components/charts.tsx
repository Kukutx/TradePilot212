// Small, dependency-free charts. Single-series only: one hue, values always labelled,
// a native tooltip on every mark, and a table fallback so nothing relies on color alone.

import { useState } from "react";

export interface BarDatum { key: string; label: string; value: number; display: string; sublabel?: string }

/** Horizontal bars for shares of a whole (weights) or ranked amounts. */
export function BarList({ data, max, title, tableLabel, valueHeader, nameHeader }: {
  data: BarDatum[];
  max?: number;
  title: string;
  tableLabel: string;
  nameHeader: string;
  valueHeader: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const top = max ?? Math.max(...data.map((item) => Math.abs(item.value)), 0);
  return (
    <figure className="chartFigure">
      <figcaption><span>{title}</span><button type="button" className="linkButton" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{tableLabel}</button></figcaption>
      {asTable ? (
        <table className="chartTable"><thead><tr><th>{nameHeader}</th><th>{valueHeader}</th></tr></thead>
          <tbody>{data.map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.display}</td></tr>)}</tbody></table>
      ) : (
        <ul className="barList">
          {data.map((item) => (
            <li key={item.key} title={`${item.label}: ${item.display}`}>
              <span className="barLabel"><strong>{item.label}</strong>{item.sublabel && <small>{item.sublabel}</small>}</span>
              <span className="barTrack"><span className={`barFill ${item.value < 0 ? "negative" : ""}`} style={{ width: `${top > 0 ? Math.max(1.5, (Math.abs(item.value) / top) * 100) : 0}%` }} /></span>
              <span className="barValue">{item.display}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Vertical bars over time (e.g. monthly income). Labels only the latest and the largest bar. */
export function ColumnChart({ data, title, tableLabel, nameHeader, valueHeader }: {
  data: BarDatum[];
  title: string;
  tableLabel: string;
  nameHeader: string;
  valueHeader: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const top = Math.max(...data.map((item) => item.value), 0);
  const largest = data.reduce<BarDatum | undefined>((best, item) => (!best || item.value > best.value ? item : best), undefined);
  const latest = data[data.length - 1];
  return (
    <figure className="chartFigure">
      <figcaption><span>{title}</span><button type="button" className="linkButton" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{tableLabel}</button></figcaption>
      {asTable ? (
        <table className="chartTable"><thead><tr><th>{nameHeader}</th><th>{valueHeader}</th></tr></thead>
          <tbody>{data.map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.display}</td></tr>)}</tbody></table>
      ) : (
        <div className="columnChart" role="img" aria-label={title}>
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
