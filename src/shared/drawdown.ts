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

/** The deepest fall in a return series and where it stands now; undefined with fewer than two days. */
export function drawdownOf(series: ReturnPoint[]): Drawdown | undefined {
  const first = series[0];
  if (!first || series.length < 2) return undefined;
  let high = 1 + first.return, highDate = first.date;
  let max = 0, peak: string | undefined, trough: string | undefined, recovered: string | undefined;
  for (const point of series.slice(1)) {
    const level = 1 + point.return;
    if (level >= high) {
      // Back at the high (or above it) for the first time since the deepest fall: that fall is made up.
      if (trough && !recovered) recovered = point.date;
      high = level;
      highDate = point.date;
      continue;
    }
    const fall = round(level / high - 1);
    if (fall < max) {
      max = fall;
      peak = highDate;
      trough = point.date;
      recovered = undefined;
    }
  }
  const last = series[series.length - 1]!;
  const current = Math.min(0, round((1 + last.return) / high - 1));
  return {
    max,
    ...(peak && trough ? { peak, trough } : {}),
    ...(recovered ? { recovered } : {}),
    current,
    ...(current < 0 ? { currentPeak: highDate } : {}),
  };
}
