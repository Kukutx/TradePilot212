// The holdings as a map: one tile per holding, its area its value in the account currency, its colour how it moved,
// on the day or since it was bought. Each tile opens the holding; its text says what the colour shows.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Position } from "../../shared/contracts";
import type { DayMove } from "../../shared/today";
import type { SupportedLocale } from "../i18n";
import { money, num, pct, walletNumber } from "../lib/format";
import { holdingReturn, type MapMeasure } from "../lib/holdings";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { treemap } from "../lib/treemap";
import type { TodayState } from "./day";

export type { MapMeasure };

/** The colour scale's end, either way: the smallest of these that covers most holdings, so one outlier does not wash out the rest. */
const DAY_STEPS = [0.01, 0.02, 0.03, 0.05, 0.1];
const TOTAL_STEPS = [0.05, 0.1, 0.25, 0.5, 1];
/** Gap between tiles, in pixels: half of it on each side of a tile. */
const GAP = 2;

export function scaleEnd(values: number[], steps: number[]): number {
  const sizes = values.map(Math.abs).sort((a, b) => a - b);
  // The move that four in five holdings stay within.
  const typical = sizes.length ? sizes[Math.floor((sizes.length - 1) * 0.8)]! : 0;
  return steps.find((step) => step >= typical) ?? steps[steps.length - 1]!;
}

/** How strongly a tile is coloured, 0 to 1: its move against the scale's end, a move beyond it at full strength. */
export const strength = (value: number, end: number) => Math.min(1, Math.abs(value) / end);

/** The map's height for its width: wide on a desktop, near square on a phone. */
export const mapHeight = (width: number) => (width < 480 ? Math.round(width * 0.95) : Math.round(Math.min(440, Math.max(260, width * 0.46))));

interface Tile {
  position: Position;
  name: string;
  value: number;
  share: number;
  /** The move the colour shows: the day's change, or the return since bought. */
  move?: number;
  /** The amount beside it, in the account currency: the day's result, or the result since bought. */
  amount?: number;
  loading?: boolean;
}

/** Whether the map can colour by the day: the moves are being read, or some holding has one. */
export const mapDayKnown = (today: TodayState | undefined) => Boolean(today && !today.failed && (today.loading || today.data?.moves.some((move) => move.change !== undefined)));

export function HoldingsMap({ positions, moves, today, measure, currency, book, locale, t, onOpen, initialWidth = 720 }: {
  positions: Position[];
  moves: Map<string, DayMove>;
  today?: TodayState;
  /** What the colour shows; the caller offers the day only when mapDayKnown. */
  measure: MapMeasure;
  currency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onOpen?: (ticker: string) => void;
  /** The width laid out before the map is measured (and in tests). */
  initialWidth?: number;
}) {
  const [width, setWidth] = useState(initialWidth);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width))); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const total = positions.reduce((sum, position) => sum + Math.max(0, walletNumber(position, "currentValue") ?? 0), 0);
  const tiles: Tile[] = positions.flatMap((position) => {
    const value = walletNumber(position, "currentValue");
    if (!value || value <= 0) return [];
    const name = instrumentLabel(position.instrument.ticker, book, position.instrument);
    const day = moves.get(position.instrument.ticker);
    // The symbol: tiles are small.
    const base = { position, name: name.detail || name.name, value, share: total ? value / total : 0 };
    if (measure === "day") {
      return [{ ...base, ...(day?.change !== undefined ? { move: day.change } : {}), ...(day?.profitLoss !== undefined ? { amount: day.profitLoss } : {}), ...(!day && today?.loading ? { loading: true } : {}) }];
    }
    const result = walletNumber(position, "unrealizedProfitLoss");
    const back = holdingReturn(position);
    return [{ ...base, ...(back !== undefined ? { move: back } : {}), ...(result !== undefined ? { amount: result } : {}) }];
  });
  const end = scaleEnd(tiles.flatMap((tile) => (tile.move === undefined ? [] : [tile.move])), measure === "day" ? DAY_STEPS : TOTAL_STEPS);
  const height = mapHeight(width);
  const laid = treemap(tiles.map((tile) => ({ value: tile.value, item: tile })), width, height);
  const label = (tile: Tile) => fill(t(measure === "day" ? "mapTileDay" : "mapTileTotal"), {
    name: instrumentLabel(tile.position.instrument.ticker, book, tile.position.instrument).name,
    value: money(tile.value, currency, locale),
    share: pct(tile.share, locale, 1),
    move: tile.move === undefined ? (tile.loading ? t("mapLoading") : t("mapNoMove")) : pct(tile.move, locale, 2, { signed: true }),
    amount: tile.amount === undefined ? "" : fill(t("mapAmountPart"), { amount: money(tile.amount, currency, locale, { signed: true }) }),
  });
  return (
    <div className="holdingsMapWrap">
      <MapLegend end={end} locale={locale} t={t} missing={tiles.some((tile) => tile.move === undefined && !tile.loading)} />
      <div ref={box} className="holdingsMap" style={{ height }} role="list" aria-label={fill(t(measure === "day" ? "mapCaptionDay" : "mapCaptionTotal"), { count: num(tiles.length, locale) })}>
        {laid.map(({ item: tile, x, y, width: w, height: h }) => {
          // The colour carries the sign; the text stays in the text colour, with its sign written out.
          const tone = tile.move === undefined || tile.move === 0 ? "" : tile.move > 0 ? "up" : "down";
          const size = w >= 120 && h >= 72 ? "large" : w >= 64 && h >= 42 ? "medium" : w >= 40 && h >= 22 ? "small" : "tiny";
          const px = (value: number) => Math.round(value * 10) / 10;
          const style = {
            left: px(x + GAP / 2), top: px(y + GAP / 2), width: px(Math.max(0, w - GAP)), height: px(Math.max(0, h - GAP)),
            ...(tile.move !== undefined ? { "--tile-strength": strength(tile.move, end).toFixed(3) } : {}),
          } as CSSProperties;
          const text = label(tile);
          const content = (
            <>
              {size !== "tiny" && <span className="mapName">{tile.name}</span>}
              {(size === "large" || size === "medium") && <strong className="mapMove">{tile.move === undefined ? (tile.loading ? "…" : "—") : pct(tile.move, locale, size === "large" ? 2 : 1, { signed: true })}</strong>}
              {size === "large" && tile.amount !== undefined && <small className="mapAmount">{money(tile.amount, currency, locale, { signed: true })}</small>}
            </>
          );
          const className = `mapTile ${size}${tone ? ` ${tone}` : ""}${tile.move === undefined && !tile.loading ? " none" : ""}`;
          return (
            <div key={tile.position.instrument.ticker} role="listitem" className="mapCell" style={style}>
              {onOpen
                ? <button type="button" className={className} title={text} aria-label={text} onClick={() => onOpen(tile.position.instrument.ticker)}>{content}</button>
                : <div className={className} title={text} aria-label={text}>{content}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The colour scale, from the end of losses through no change to the end of gains, and the pattern for no figure. */
function MapLegend({ end, locale, t, missing }: { end: number; locale: SupportedLocale; t: Translator; missing: boolean }) {
  return (
    <p className="mapLegend">
      <span className="visuallyHidden">{fill(t("mapLegend"), { end: pct(end, locale, 0) })}</span>
      <span className="mapScaleEnd" aria-hidden="true">{pct(-end, locale, 0)}</span>
      <span className="mapScale" aria-hidden="true" />
      <span className="mapScaleEnd" aria-hidden="true">{pct(end, locale, 0, { signed: true })}</span>
      {missing && <span className="mapMissing" aria-hidden="true"><i />{t("mapNoMove")}</span>}
      <span className="mapSize">{t("mapSize")}</span>
    </p>
  );
}
