// A holding's value on each day of its closes, beside the net put in: the shares held at the first close at that close,
// plus what was bought since, less what was sold, at their fill prices. The gap between the two lines is what the price
// did for the position. Trading 212 reports only today's shares, so each day's are today's less the buys after it plus
// the sells after it. Amounts are in the account currency, at today's exchange rate where it is known.

import type { HoldingDetail } from "./holding.js";
import type { PricePoint } from "./prices.js";

export interface PositionFill {
  at: string;
  /** Shares, positive for a buy and negative for a sell. */
  quantity: number;
  price: number;
}

export interface PositionDay {
  date: string;
  shares: number;
  /** The shares at that day's close. */
  value: number;
  /** The net put in: the shares at the start at the first close, plus the buys since, less the sells, at their fill prices. */
  base: number;
}

export interface PositionHistory {
  days: PositionDay[];
  startShares: number;
  /** The value on the last day less its base: what the price did for the position over the closes. */
  gain: number;
  /** Older fills were not read, so it starts on the day of the oldest one read. */
  shortened?: true;
  /** Today's exchange rate is not known (nothing in the instrument's currency is held), so amounts are at its fills'. */
  fillRates?: true;
}

/**
 * Why there is no history: "quantity" when going back through the fills leaves fewer than no shares (shares moved out
 * without a fill), "split" when the closes or the fill prices jump as across a split, "fills" when fills were read
 * without a price or date.
 */
export type PositionProblem = "quantity" | "split" | "fills";

/** Fewer shares than this are none. */
const NO_SHARES = 1e-6;
/** Two closes in a row this far apart, or a fill this far from its day's close, look like a split. */
const SPLIT_JUMP = { up: 1.8, down: 0.55 };
const FILL_OFF = { up: 1.4, down: 0.7 };

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits || 0;

/**
 * The position's days from its closes and fills; a problem when they do not add up, and undefined with fewer than two
 * closes or no shares on any of them. `rate` is instrument units per account unit. A fill counts at the close of its
 * UTC date, so one after the close shows a day early; shares moved in without a fill count as held from the start.
 */
export function positionHistory(input: { closes: PricePoint[]; fills: PositionFill[]; quantity: number; rate: number }): PositionHistory | "quantity" | "split" | undefined {
  const closes = input.closes.filter((point) => point.close > 0);
  if (closes.length < 2 || !(input.rate > 0)) return undefined;
  const dayOf = (at: string) => at.slice(0, 10);
  const fills = input.fills.filter((fill) => Number.isFinite(fill.quantity) && fill.quantity !== 0 && fill.price > 0 && dayOf(fill.at) >= closes[0]!.date);
  // Closes not adjusted for a split jump on its day; adjusted ones sit far from the fills' prices before it.
  for (let index = 1; index < closes.length; index++) {
    const ratio = closes[index]!.close / closes[index - 1]!.close;
    if (ratio >= SPLIT_JUMP.up || ratio <= SPLIT_JUMP.down) return "split";
  }
  for (const fill of fills) {
    const close = closes.filter((point) => point.date <= dayOf(fill.at)).at(-1)!;
    const ratio = fill.price / close.close;
    if (ratio >= FILL_OFF.up || ratio <= FILL_OFF.down) return "split";
  }
  // Shares at the first close: today's, less every fill after that day.
  const after = (date: string) => fills.filter((fill) => dayOf(fill.at) > date).reduce((sum, fill) => sum + fill.quantity, 0);
  let startShares = input.quantity - after(closes[0]!.date);
  if (Math.abs(startShares) < NO_SHARES) startShares = 0;
  const startValue = (startShares * closes[0]!.close) / input.rate;
  const days: PositionDay[] = [];
  for (const point of closes) {
    let shares = input.quantity - after(point.date);
    if (Math.abs(shares) < NO_SHARES) shares = 0;
    if (shares < 0) return "quantity";
    const traded = fills.filter((fill) => dayOf(fill.at) > closes[0]!.date && dayOf(fill.at) <= point.date).reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
    days.push({ date: point.date, shares: round(shares, 8), value: round((shares * point.close) / input.rate), base: round(startValue + traded / input.rate) });
  }
  if (!days.some((day) => day.shares > 0)) return undefined;
  const last = days[days.length - 1]!;
  return { days, startShares: round(startShares, 8), gain: round(last.value - last.base) };
}

/** The most fills the holding page keeps; with this many, older ones in the year may be missing. */
const MAX_READ_FILLS = 200;

/**
 * The position history of a holding page: its closes, its fills of the year and today's shares, at the rate Trading
 * 212's own valuation implies (sold out, today's rate from another holding in its currency, else its fills' rate).
 * When older fills were not read, it starts on the day of the oldest one read: every fill after that day is known.
 */
export function holdingPositionHistory(data: HoldingDetail): PositionHistory | PositionProblem | undefined {
  const history = data.history;
  if (!data.prices || data.prices.points.length < 2 || !history) return undefined;
  if (history.fillsUnpriced || history.fills.some((fill) => fill.quantity && (!fill.filledAt || !fill.price))) return "fills";
  // A split or a distribution comes as a fill that is not a trade: shares with no price paid.
  if (history.fillsNotTrades) return "split";
  const fills: PositionFill[] = [
    ...history.fills.flatMap((fill) => {
      if (!fill.filledAt || !fill.price || !fill.quantity) return [];
      const sell = String(fill.side ?? "").toUpperCase() === "SELL" || fill.quantity < 0;
      return [{ at: fill.filledAt, quantity: sell ? -Math.abs(fill.quantity) : Math.abs(fill.quantity), price: fill.price }];
    }),
    ...(history.olderFills ?? []).map((fill) => ({ at: fill.filledAt, quantity: fill.side === "SELL" ? -fill.quantity : fill.quantity, price: fill.price })),
  ];
  let closes = data.prices.points;
  const shortened = history.fillsTruncated || history.fills.length + (history.olderFills?.length ?? 0) >= MAX_READ_FILLS;
  if (shortened) {
    if (!fills.length) return "fills";
    const oldest = fills.reduce((day, fill) => (fill.at.slice(0, 10) < day ? fill.at.slice(0, 10) : day), fills[0]!.at.slice(0, 10));
    closes = closes.filter((point) => point.date >= oldest);
  }
  const position = data.position;
  const value = (position?.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
  let rate: number | undefined;
  let fillRates = false;
  if (position && position.quantity > 0 && typeof value === "number" && value > 0 && position.currentPrice > 0) {
    rate = (position.quantity * position.currentPrice) / value;
  } else if (data.accountRate && data.accountRate > 0) {
    rate = data.accountRate;
  } else {
    const rated = history.fills.filter((fill) => fill.price && fill.quantity && fill.netValue);
    const local = rated.reduce((sum, fill) => sum + Math.abs(fill.quantity! * fill.price!), 0);
    const account = rated.reduce((sum, fill) => sum + Math.abs(fill.netValue!), 0);
    if (local > 0 && account > 0) [rate, fillRates] = [local / account, true];
  }
  if (!rate) return undefined;
  const drawn = positionHistory({ closes, fills, quantity: position?.quantity ?? 0, rate });
  if (!drawn || typeof drawn !== "object") return drawn;
  return { ...drawn, ...(shortened ? { shortened: true as const } : {}), ...(fillRates ? { fillRates: true as const } : {}) };
}
