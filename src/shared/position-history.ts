// A holding's value on each day of its closes, beside what it would be had the price not moved since the first one:
// the shares then at the first close, plus what was bought since, less what was sold, at their fill prices. The gap
// between the two lines is what the price did for the position. Trading 212 reports only today's shares, so each
// day's are today's less the buys after it plus the sells after it. Amounts are in the account currency at today's
// exchange rate.

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
  /** The shares at the start at the first close, plus the buys since, less the sells, at their fill prices. */
  base: number;
}

export interface PositionHistory {
  days: PositionDay[];
  startShares: number;
  /** The value on the last day less its base: what the price did for the position over the closes. */
  gain: number;
}

/** Fewer shares than this are none. */
const NO_SHARES = 1e-6;

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits || 0;

/**
 * The position's days from its closes and fills; "quantity" when the shares do not add up (a split, or shares moved in
 * or out without a fill), and undefined with fewer than two closes or no shares on any of them. `rate` is instrument
 * units per account unit.
 */
export function positionHistory(input: { closes: PricePoint[]; fills: PositionFill[]; quantity: number; rate: number }): PositionHistory | "quantity" | undefined {
  const closes = input.closes.filter((point) => point.close > 0);
  if (closes.length < 2 || !(input.rate > 0)) return undefined;
  const dayOf = (at: string) => at.slice(0, 10);
  const fills = input.fills.filter((fill) => Number.isFinite(fill.quantity) && fill.quantity !== 0 && fill.price > 0 && dayOf(fill.at) >= closes[0]!.date);
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

/** The most fills the holding page reads; with this many, older ones in the year may be missing. */
const MAX_READ_FILLS = 200;

/**
 * The position history of a holding page: its closes, its fills of the year and today's shares, at the rate Trading
 * 212's own valuation implies (or, sold out, the rate its fills imply). "fills" when the fills may be incomplete.
 */
export function holdingPositionHistory(data: HoldingDetail): PositionHistory | "quantity" | "fills" | undefined {
  const history = data.history;
  if (!data.prices || data.prices.points.length < 2 || !history) return undefined;
  const fills: PositionFill[] = [
    ...history.fills.flatMap((fill) => {
      if (!fill.filledAt || !fill.price || !fill.quantity) return [];
      const sell = String(fill.side ?? "").toUpperCase() === "SELL" || fill.quantity < 0;
      return [{ at: fill.filledAt, quantity: sell ? -Math.abs(fill.quantity) : Math.abs(fill.quantity), price: fill.price }];
    }),
    ...(history.olderFills ?? []).map((fill) => ({ at: fill.filledAt, quantity: fill.side === "SELL" ? -fill.quantity : fill.quantity, price: fill.price })),
  ];
  if (history.fillsTruncated || history.fills.length + (history.olderFills?.length ?? 0) >= MAX_READ_FILLS) return "fills";
  const position = data.position;
  const value = (position?.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
  let rate: number | undefined;
  if (position && position.quantity > 0) {
    if (typeof value === "number" && value > 0 && position.currentPrice > 0) rate = (position.quantity * position.currentPrice) / value;
  } else {
    const rated = history.fills.filter((fill) => fill.price && fill.quantity && fill.netValue);
    const local = rated.reduce((sum, fill) => sum + Math.abs(fill.quantity! * fill.price!), 0);
    const account = rated.reduce((sum, fill) => sum + Math.abs(fill.netValue!), 0);
    if (local > 0 && account > 0) rate = local / account;
  }
  if (!rate) return undefined;
  return positionHistory({ closes: data.prices.points, fills, quantity: position?.quantity ?? 0, rate });
}
