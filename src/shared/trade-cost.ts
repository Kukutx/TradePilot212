// What a set of trades comes to, and what converting the part in other currencies costs. Trading 212 charges a fee
// on each currency conversion (0.15% on Invest and ISA accounts). A trade paid from, or into, a balance held in the
// instrument's own currency converts nothing, so the fee here is what it comes to when every such trade converts:
// at most that.

/** Trading 212's currency conversion fee on Invest and ISA accounts, as a share of the amount converted. */
export const DEFAULT_FX_FEE_RATE = 0.0015;

/** The highest conversion fee the FX_FEE_RATE setting takes: 5%. */
export const MAX_FX_FEE_RATE = 0.05;

export interface TradeValue {
  side: "buy" | "sell";
  /** In the account currency. */
  value: number;
  /** The instrument's quote currency; a trade whose currency is not known counts as converted. */
  currency?: string;
}

export interface TradeTotals {
  /** The account currency the amounts are in. */
  currency: string;
  /** What the buys come to. */
  bought: number;
  /** What the sells come to. */
  sold: number;
  /** The part of the buys and sells in another currency than the account's, which Trading 212 converts. */
  converted: number;
  /** The conversion fee on that, at fxFeeRate: at most this, as a balance in an instrument's currency converts nothing. */
  fxFee: number;
  fxFeeRate: number;
  /** Trades in a currency not known, counted as converted. */
  unknownCurrency?: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Pence and pounds are one currency: nothing is converted between them. */
export const currencyOfAccount = (code: string) => {
  const upper = code.toUpperCase();
  return upper === "GBX" ? "GBP" : upper;
};

/** The totals of `trades`, with the conversion fee at `fxFeeRate` on the part in another currency than `accountCurrency`. */
export function tradeTotals(trades: ReadonlyArray<TradeValue>, accountCurrency: string, fxFeeRate = DEFAULT_FX_FEE_RATE): TradeTotals {
  const account = currencyOfAccount(accountCurrency);
  let bought = 0;
  let sold = 0;
  let converted = 0;
  let unknown = 0;
  for (const trade of trades) {
    const value = Math.abs(trade.value);
    if (!(value > 0)) continue;
    if (trade.side === "buy") bought += value;
    else sold += value;
    if (!trade.currency) unknown += 1;
    if (!trade.currency || currencyOfAccount(trade.currency) !== account) converted += value;
  }
  return {
    currency: accountCurrency,
    bought: cents(bought),
    sold: cents(sold),
    converted: cents(converted),
    fxFee: cents(converted * fxFeeRate),
    fxFeeRate,
    ...(unknown ? { unknownCurrency: unknown } : {}),
  };
}

export interface WeightMove {
  ticker: string;
  /** Share of the account today. */
  current: number;
  /** Share of the account wanted. */
  target: number;
  currency?: string;
}

/**
 * The trades that move each holding or target from its share today to the one wanted, by value: the change in share
 * times the account's value. Changes smaller than `minTradeValue` are left out, as the rebalance planner leaves them.
 * Shares, not shares counted: a rebalance's whole-share rounding and its cash limit can trade a little less.
 */
export function weightTrades(moves: ReadonlyArray<WeightMove>, totalValue: number, minTradeValue = 1): Array<TradeValue & { ticker: string }> {
  if (!(totalValue > 0)) return [];
  const trades: Array<TradeValue & { ticker: string }> = [];
  for (const move of moves) {
    const change = (move.target - move.current) * totalValue;
    if (Math.abs(change) < minTradeValue) continue;
    trades.push({ ticker: move.ticker, side: change > 0 ? "buy" : "sell", value: Math.abs(change), ...(move.currency ? { currency: move.currency } : {}) });
  }
  return trades;
}
