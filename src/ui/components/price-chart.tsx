// The price chart on the holding page: the daily closes as one line, your fills as markers on it, and the average
// cost, open stops and limits and armed alerts as dashed lines across it, each with a price tag on the axis.
// A crosshair names the day, its close and any trade on it; a table lists the same.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PRICE_RANGES, priceMove, pricesIn, type PriceHistory, type PricePoint, type PriceRange } from "../../shared/prices";
import { localeTag, type MessageKey, type SupportedLocale } from "../i18n";
import { amount, dayLabel, num, pct, signedClass } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { decimalsOf, niceTicks, ViewSwitch } from "./charts";

/** One fill, placed at its day and price; `text` is what the crosshair says about it. */
export interface ChartTrade {
  key: string;
  time: number;
  price: number;
  side: "buy" | "sell";
  text: string;
}

export type ChartLevelKind = "average" | "stop" | "limit" | "alert";

export interface ChartLevel {
  key: string;
  kind: ChartLevelKind;
  price: number;
  label: string;
}

const HEIGHT = 236;
/** The price axis and the tags sit on the right, as in a broker's chart, so the line keeps the width on a phone. */
const PAD = { top: 14, right: 64, bottom: 28, left: 6 };
const DAY_MS = 86_400_000;
const TAG_HEIGHT = 18;
/** A level further than this factor from the closes would flatten the line; it is named under the chart instead. */
const LEVEL_REACH = 1.5;

const RANGE_KEYS: Record<PriceRange, [MessageKey, MessageKey]> = {
  "1m": ["period1mShort", "period1m"],
  "3m": ["period3mShort", "period3m"],
  "6m": ["period6mShort", "period6m"],
  "1y": ["period1yShort", "period1y"],
};
const LEVEL_KEYS: Record<ChartLevelKind, MessageKey> = { average: "levelAverage", stop: "priceLegendStop", limit: "priceLegendLimit", alert: "priceLegendAlert" };

const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * The ranges worth offering: each one longer than the closes cover adds nothing, so after the first range that
 * reaches back to the oldest close the rest are left out (Alpha Vantage's free plan gives about five months).
 */
export function priceRanges(points: PricePoint[]): PriceRange[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  const span = (dayTime(last.date) - dayTime(first.date)) / DAY_MS;
  const ranges: PriceRange[] = [];
  for (const [key, days] of PRICE_RANGES) {
    ranges.push(key);
    if (days >= span) break;
  }
  return ranges;
}

/** Tag centres pushed apart so no two overlap, kept inside the plot; input and output in the same order. */
export function spreadTags(wanted: number[], top: number, bottom: number, gap = TAG_HEIGHT + 2): number[] {
  const order = wanted.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  const placed = order.map((item) => item.y);
  for (let index = 0; index < placed.length; index++) placed[index] = Math.max(placed[index]!, index ? placed[index - 1]! + gap : top);
  // Pushed past the bottom: walk back up.
  for (let index = placed.length - 1; index >= 0; index--) placed[index] = Math.min(placed[index]!, index === placed.length - 1 ? bottom : placed[index + 1]! - gap);
  const result = new Array<number>(wanted.length);
  order.forEach((item, index) => { result[item.index] = placed[index]!; });
  return result;
}

/** Month starts for the time axis (the year in place of January), thinned to fit; Mondays for a month's range. */
function timeTicks(start: number, end: number, plotWidth: number, locale: SupportedLocale, weekly: boolean): Array<{ time: number; label: string }> {
  const ticks: Array<{ time: number; label: string }> = [];
  const month = new Intl.DateTimeFormat(localeTag(locale), { month: "short", timeZone: "UTC" });
  if (weekly) {
    for (let time = start + DAY_MS; time < end; time += DAY_MS) if (new Date(time).getUTCDay() === 1) ticks.push({ time, label: dayLabel(new Date(time).toISOString(), locale, { year: false }) });
  } else {
    const date = new Date(start);
    for (let cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); cursor < end; ) {
      const at = new Date(cursor);
      ticks.push({ time: cursor, label: at.getUTCMonth() === 0 ? String(at.getUTCFullYear()) : month.format(at) });
      cursor = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
    }
  }
  const room = Math.max(1, Math.floor(plotWidth / (weekly ? 64 : 48)));
  const step = Math.ceil(ticks.length / room);
  return ticks.filter((_, index) => index % step === 0);
}

export function PriceChart({ prices, trades, levels, currency, locale, t }: {
  prices: PriceHistory;
  trades: ChartTrade[];
  levels: ChartLevel[];
  /** The instrument's currency, for the tags and the tooltip. */
  currency?: string;
  locale: SupportedLocale;
  t: Translator;
}) {
  const ranges = priceRanges(prices.points);
  const [chosen, setChosen] = useState<PriceRange | undefined>(undefined);
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width))); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);

  const range = chosen && ranges.includes(chosen) ? chosen : ranges[ranges.length - 1] ?? "1y";
  const days = PRICE_RANGES.find(([key]) => key === range)![1];
  const inRange = pricesIn(prices.points, days);
  const points = inRange.length >= 2 ? inRange : prices.points;
  const move = priceMove(points)!;
  const times = points.map((point) => dayTime(point.date));
  const start = times[0]!;
  const end = times[times.length - 1]!;
  // A trade sits on its day's close; one after the newest close (today, before the provider has it) at the end.
  const tradeDay = (trade: ChartTrade) => Math.floor(trade.time / DAY_MS) * DAY_MS;
  const shownTrades = trades.filter((trade) => tradeDay(trade) >= start).sort((a, b) => a.time - b.time);
  /** The point a trade belongs to: the last close on or before its day. */
  const pointOf = (trade: ChartTrade) => { let found = 0; for (let index = 0; index < times.length && times[index]! <= tradeDay(trade); index++) found = index; return found; };
  const tradesAt = new Map<number, ChartTrade[]>();
  for (const trade of shownTrades) tradesAt.set(pointOf(trade), [...(tradesAt.get(pointOf(trade)) ?? []), trade]);

  const closes = points.map((point) => point.close);
  const lowClose = Math.min(...closes);
  const highClose = Math.max(...closes);
  const near = (price: number) => price >= lowClose / LEVEL_REACH && price <= highClose * LEVEL_REACH;
  const drawn = levels.filter((level) => near(level.price));
  const farAway = levels.filter((level) => !near(level.price));
  let low = Math.min(lowClose, ...drawn.map((level) => level.price), ...shownTrades.map((trade) => trade.price));
  let high = Math.max(highClose, ...drawn.map((level) => level.price), ...shownTrades.map((trade) => trade.price));
  if (high - low < 1e-9) { low *= 0.99; high *= 1.01; }
  const grid = niceTicks(low, high);
  const span = high - low;
  low -= span * 0.06;
  high += span * 0.06;

  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const right = PAD.left + plotWidth;
  const base = PAD.top + plotHeight;
  const x = (time: number) => PAD.left + (end > start ? Math.min(1, Math.max(0, (time - start) / (end - start))) : 0.5) * plotWidth;
  const y = (price: number) => PAD.top + (1 - (price - low) / (high - low)) * plotHeight;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(times[index]!).toFixed(1)},${y(point.close).toFixed(1)}`).join("");
  const area = `${line}L${x(end).toFixed(1)},${base}L${x(start).toFixed(1)},${base}Z`;

  // The last close and each level drawn get a tag on the axis; a gridline value under a tag is left out.
  const tagged = [{ key: "last", kind: "last" as const, price: move.last.close }, ...drawn];
  const tagY = spreadTags(tagged.map((item) => y(item.price)), PAD.top + TAG_HEIGHT / 2, base - TAG_HEIGHT / 2);
  const axisDigits = decimalsOf(grid.step);
  const tagDigits = Math.max(axisDigits, move.last.close < 10 ? 3 : move.last.close < 1000 ? 2 : 1);
  const gridLabels = grid.ticks.filter((tick) => tagY.every((tagCentre) => Math.abs(tagCentre - y(tick)) > TAG_HEIGHT / 2 + 4));
  const ticks = timeTicks(start, end, plotWidth, locale, range === "1m");

  const label = (key: PriceRange) => t(RANGE_KEYS[key][1]);
  const point = active === null ? undefined : points[active];
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const time = start + ((event.clientX - rect.left - PAD.left) / Math.max(1, plotWidth)) * (end - start);
    let nearest = 0;
    for (let index = 1; index < times.length; index++) if (Math.abs(times[index]! - time) < Math.abs(times[nearest]! - time)) nearest = index;
    setActive(nearest);
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = points.length - 1;
    const keys: Record<string, (current: number) => number> = {
      ArrowLeft: (current) => current - 1,
      ArrowRight: (current) => current + 1,
      Home: () => 0,
      End: () => last,
      // Page keys go to the previous or next day with a trade.
      PageUp: (current) => Math.max(-1, ...[...tradesAt.keys()].filter((index) => index < current)),
      PageDown: (current) => Math.min(last + 1, ...[...tradesAt.keys()].filter((index) => index > current)),
    };
    const go = keys[event.key];
    if (!go) return;
    event.preventDefault();
    setActive((current) => { const next = go(current ?? last); return next < 0 || next > last ? current ?? last : next; });
  };
  const choose = (key: PriceRange) => { setChosen(key); setActive(null); };
  const buys = shownTrades.filter((trade) => trade.side === "buy").length;
  const sells = shownTrades.length - buys;
  const kinds = [...new Set(drawn.map((level) => level.kind))];
  const summary = fill(t("priceChartLabel"), {
    range: label(range),
    from: amount(move.first.close, currency, locale),
    to: amount(move.last.close, currency, locale),
    change: pct(move.change, locale, 1, { signed: true }),
  }) + (shownTrades.length ? ` ${fill(t("priceChartTrades"), { buys: String(buys), sells: String(sells) })}` : "");

  return (
    <figure className="chartFigure priceChart">
      <figcaption>
        <span>{t("priceChartTitle")}</span>
        <span className="chartControls">
          {ranges.length > 1 && (
            <span className="segmented" role="radiogroup" aria-label={t("period")}>
              {ranges.map((key) => (
                <button key={key} type="button" role="radio" aria-checked={range === key} aria-label={label(key)} title={label(key)} className={range === key ? "active" : ""} onClick={() => choose(key)}>{t(RANGE_KEYS[key][0])}</button>
              ))}
            </span>
          )}
          <ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} />
        </span>
      </figcaption>
      <p className="priceMove">
        <strong className={signedClass(move.change)}>{pct(move.change, locale, 1, { signed: true })}</strong>
        <span>{label(range)}</span>
        <span className="priceRange">{fill(t("priceHigh"), { price: amount(move.high.close, currency, locale) })} · {fill(t("priceLow"), { price: amount(move.low.close, currency, locale) })}</span>
      </p>
      {asTable ? (
        <table className="chartTable">
          <thead><tr><th>{t("dateColumn")}</th><th>{t("priceTradesColumn")}</th><th>{t("priceCloseColumn")}</th></tr></thead>
          <tbody>{points.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => (
            <tr key={item.date} className={tradesAt.has(index) ? "withTrade" : undefined}>
              <td>{dayLabel(item.date, locale)}</td>
              <td>{tradesAt.get(index)?.map((trade) => trade.text).join("; ") ?? ""}</td>
              <td>{amount(item.close, currency, locale)}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : (
        <div className="lineChart" ref={box}>
          <svg width={width} height={HEIGHT} role="img" tabIndex={0} aria-label={summary}
            onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} onKeyDown={step} onBlur={() => setActive(null)}>
            {grid.ticks.map((tick) => <line key={tick} className="priceGrid" x1={PAD.left} x2={right} y1={y(tick)} y2={y(tick)} />)}
            {gridLabels.map((tick) => <text key={tick} className="lineAxis" x={right + 8} y={y(tick)} dy="0.32em">{num(tick, locale, axisDigits)}</text>)}
            {ticks.map((tick) => <text key={tick.time} className="lineAxis" x={x(tick.time)} y={HEIGHT - 8} textAnchor="middle">{tick.label}</text>)}
            <path className="lineArea" d={area} />
            <path className="linePath" d={line} />
            {drawn.map((level) => <line key={level.key} className={`priceLevel ${level.kind}`} x1={PAD.left} x2={right} y1={y(level.price)} y2={y(level.price)} />)}
            {shownTrades.map((trade) => {
              const cx = x(Math.min(end, tradeDay(trade)));
              const cy = y(trade.price);
              const shape = trade.side === "buy"
                ? `M${cx},${cy - 6}L${cx + 6},${cy + 5}L${cx - 6},${cy + 5}Z`
                : `M${cx},${cy + 6}L${cx + 6},${cy - 5}L${cx - 6},${cy - 5}Z`;
              return <path key={trade.key} className={`tradeMark ${trade.side}`} d={shape} />;
            })}
            {tagged.map((item, index) => {
              const centre = tagY[index]!;
              return (
                <g key={item.key} className={`priceTag ${item.kind}`}>
                  <line x1={right} x2={right + 4} y1={y(item.price)} y2={centre} />
                  <rect x={right + 4} y={centre - TAG_HEIGHT / 2} width={PAD.right - 6} height={TAG_HEIGHT} rx={5} />
                  <text x={right + 4 + (PAD.right - 6) / 2} y={centre} dy="0.34em" textAnchor="middle">{num(item.price, locale, tagDigits)}</text>
                </g>
              );
            })}
            {point && active !== null && (
              <g className="lineFocus">
                <line x1={x(times[active]!)} x2={x(times[active]!)} y1={PAD.top} y2={base} />
                <circle cx={x(times[active]!)} cy={y(point.close)} r={5} />
              </g>
            )}
          </svg>
          {point && active !== null && (
            <div className="lineTip priceTip" role="status" style={{ left: `${Math.min(width - 190, Math.max(0, x(times[active]!) - 95))}px` }}>
              <span>{dayLabel(point.date, locale)}</span>
              <strong>{amount(point.close, currency, locale)}</strong>
              {active < points.length - 1 && <small className="tipSince">{fill(t("priceSince"), { change: pct(move.last.close / point.close - 1, locale, 1, { signed: true }) })}</small>}
              {tradesAt.get(active)?.map((trade) => <small key={trade.key} className={`tipTrade ${trade.side}`}>{trade.text}</small>)}
            </div>
          )}
        </div>
      )}
      {(shownTrades.length > 0 || kinds.length > 0) && (
        <ul className="priceLegend">
          {buys > 0 && <li><span className="legendMark buy" aria-hidden="true" />{t("buy")}</li>}
          {sells > 0 && <li><span className="legendMark sell" aria-hidden="true" />{t("sell")}</li>}
          {kinds.map((kind) => <li key={kind}><span className={`legendLine ${kind}`} aria-hidden="true" />{t(LEVEL_KEYS[kind])}</li>)}
        </ul>
      )}
      {farAway.length > 0 && <p className="panelNote">{fill(t("priceOffChart"), { list: farAway.map((level) => `${level.label} ${amount(level.price, currency, locale)}`).join(", ") })}</p>}
      <p className="panelNote">{prices.source === "sample" ? t("priceSample") : fill(t("priceSource"), { source: providerName(prices.source), symbol: prices.symbol ?? "" })}</p>
    </figure>
  );
}

const PROVIDERS: Record<string, string> = { stooq: "Stooq", finnhub: "Finnhub", twelvedata: "Twelve Data", alphavantage: "Alpha Vantage" };
const providerName = (source: string) => PROVIDERS[source] ?? source;
