// How far a return fell from its high: the deepest fall, the high it fell from, the low and the day it was made up,
// and how far below its high it ends. Read from the time-weighted return, so deposits and withdrawals are neither
// rises nor falls. The performance tool and the Performance tab's drawdown chart both use it.

import type { Drawdown, ReturnPoint } from "./history.js";

const round = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

/** Each day's fall from the highest point up to it, as a fraction: 0 on a day at a new high. */
export function drawdownSeries(series: ReturnPoint[]): ReturnPoint[] {
  let high = 0;
  return series.map((point) => {
    const level = 1 + point.return;
    high = Math.max(high, level);
    return { date: point.date, return: high > 0 ? round(level / high - 1) : 0 };
  });
}

/** A fall shallower than this (0.05%) counts as being at the high: it would read as 0.0% wherever it is shown. */
const MIN_FALL = 0.0005;

/**
 * The deepest fall in a return series and where it stands now; undefined with fewer than two days. A day within 0.05%
 * of the high is at it: such a fall is not counted, and coming back that close makes a fall up.
 */
export function drawdownOf(series: ReturnPoint[]): Drawdown | undefined {
  const first = series[0];
  if (!first || series.length < 2) return undefined;
  let high = 1 + first.return, highDate = first.date;
  let max = 0, peak: string | undefined, trough: string | undefined, recovered: string | undefined;
  for (const point of series.slice(1)) {
    const level = 1 + point.return;
    const fall = round(level / high - 1);
    if (fall > -MIN_FALL) {
      // Back at the high for the first time since the deepest fall: that fall is made up.
      if (trough && !recovered) recovered = point.date;
      if (level >= high) {
        high = level;
        highDate = point.date;
      }
      continue;
    }
    if (fall < max) {
      max = fall;
      peak = highDate;
      trough = point.date;
      recovered = undefined;
    }
  }
  const last = series[series.length - 1]!;
  const below = round((1 + last.return) / high - 1);
  const current = below > -MIN_FALL ? 0 : below;
  return {
    max,
    ...(peak && trough ? { peak, trough } : {}),
    ...(recovered ? { recovered } : {}),
    current,
    ...(current < 0 ? { currentPeak: highDate } : {}),
  };
}
