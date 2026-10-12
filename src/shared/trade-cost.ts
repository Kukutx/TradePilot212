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
  /**
   * Set when the cash on hand, with what the sells raise, falls short of the buys: the share of each buy it pays for,
   * the buys above already scaled to it (0 when there is no cash to buy with), as a rebalance scales them.
   */
  buysScaled?: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Pence and pounds are one currency: nothing is converted between them. */
export const currencyOfAccount = (code: string) => {
  const upper = code.toUpperCase();
  return upper === "GBX" ? "GBP" : upper;
};

/** A currency code as given, or undefined for none or the "?" an unknown one is shown as. */
export const knownCurrency = (code: string | undefined) => (code && code !== "?" ? code : undefined);

/** Whether a trade in `currency` is converted from or to `accountCurrency`: one in a currency not known counts as converted. */
const converts = (currency: string | undefined, accountCurrency: string) => !knownCurrency(currency) || currencyOfAccount(currency!) !== currencyOfAccount(accountCurrency);

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
    if (!knownCurrency(trade.currency)) unknown += 1;
    if (converts(trade.currency, account)) converted += value;
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
 * Changes of share below this are the rounding of a target to the 0.01% it is kept to, not a move wanted; the
 * estimates leave them out.
 */
export const ROUNDING_SHARE = 0.00005;

/**
 * The trades that move each holding or target from its share today to the one wanted, by value: the change in share
 * times the account's value. Changes smaller than `minTradeValue` are left out, as the rebalance planner leaves them,
 * and so are changes within the rounding of a target (ROUNDING_SHARE). By value, not by shares: a rebalance's
 * whole-share rounding can trade a little less. `fundBuys` then fits the buys to the cash.
 */
export function weightTrades(moves: ReadonlyArray<WeightMove>, totalValue: number, minTradeValue = 1): Array<TradeValue & { ticker: string }> {
  if (!(totalValue > 0)) return [];
  const trades: Array<TradeValue & { ticker: string }> = [];
  for (const move of moves) {
    const change = (move.target - move.current) * totalValue;
    if (Math.abs(change) < minTradeValue || Math.abs(move.target - move.current) <= ROUNDING_SHARE + 1e-12) continue;
    trades.push({ ticker: move.ticker, side: change > 0 ? "buy" : "sell", value: Math.abs(change), ...(move.currency ? { currency: move.currency } : {}) });
  }
  return trades;
}

/**
 * The buys scaled, as a rebalance scales them, to what the sells raise net of the conversion fee plus `spareCash` (the
 * cash above the cash target): each buy and its fee fit in it. Buys that come to less than `minTradeValue` are left
 * out. `scale` is the share of each buy paid for, below 1 only when the cash, without the fee, falls short.
 */
export function fundBuys<T extends TradeValue>(trades: ReadonlyArray<T>, spareCash: number, accountCurrency: string, fxFeeRate = DEFAULT_FX_FEE_RATE, minTradeValue = 1): { trades: T[]; scale: number } {
  const feeOf = (trade: TradeValue) => (converts(trade.currency, accountCurrency) ? fxFeeRate : 0);
  const sells = trades.filter((trade) => trade.side === "sell");
  const buys = trades.filter((trade) => trade.side === "buy");
  const budget = Math.max(0, spareCash + sells.reduce((sum, trade) => sum + trade.value * (1 - feeOf(trade)), 0));
  const wanted = buys.reduce((sum, trade) => sum + trade.value, 0);
  const cost = buys.reduce((sum, trade) => sum + trade.value * (1 + feeOf(trade)), 0);
  if (!(cost > budget)) return { trades: [...trades], scale: 1 };
  const scale = budget / cost;
  const scaled = buys.map((trade) => ({ ...trade, value: trade.value * scale })).filter((trade) => trade.value >= minTradeValue);
  // Short only of the fee, the buys are a hair smaller and fully paid for; short of the buys themselves, scaled.
  return { trades: [...sells, ...scaled], scale: budget + 0.005 < wanted ? scale : 1 };
}

/**
 * What a rebalance from today's shares to the ones wanted would trade, as the drift and the target form estimate it:
 * by weight, the buys fitted to the cash above the cash target (`spareCash`, when known) and what the sells raise.
 */
export function rebalanceEstimate(moves: ReadonlyArray<WeightMove>, totalValue: number, accountCurrency: string, fxFeeRate = DEFAULT_FX_FEE_RATE, spareCash?: number): TradeTotals {
  const wanted = weightTrades(moves, totalValue);
  const funded = spareCash === undefined ? { trades: wanted, scale: 1 } : fundBuys(wanted, spareCash, accountCurrency, fxFeeRate);
  const totals = tradeTotals(funded.trades, accountCurrency, fxFeeRate);
  // Down to 0.01%, so a share just short of all never reads as all.
  return funded.scale < 1 ? { ...totals, buysScaled: Math.floor(funded.scale * 10_000) / 10_000 } : totals;
}

/**
 * What a rebalance of only the moves further off than the band would trade (plan_portfolio_rebalance with `band`),
 * estimated as `rebalanceEstimate` estimates a full one: `over` move to their targets, their buys fitted to the cash.
 * When the cash is known and more than the band would be left above the cash target, it goes, as the planner puts
 * it, to the moves in `within` below their target. `tickers` are the ones over the band traded, `cashTo` those within
 * it bought with that cash.
 */
export function bandEstimate(over: ReadonlyArray<WeightMove>, within: ReadonlyArray<WeightMove>, band: number, totalValue: number, accountCurrency: string, fxFeeRate = DEFAULT_FX_FEE_RATE, spareCash?: number):
  { tickers: string[]; cashTo: string[]; totals: TradeTotals } {
  const feeOf = (trade: TradeValue) => (converts(trade.currency, accountCurrency) ? fxFeeRate : 0);
  const wanted = weightTrades(over, totalValue);
  const funded = spareCash === undefined ? { trades: wanted, scale: 1 } : fundBuys(wanted, spareCash, accountCurrency, fxFeeRate);
  let extra: Array<TradeValue & { ticker: string }> = [];
  if (spareCash !== undefined && totalValue > 0) {
    const left = funded.trades.reduce((sum, trade) => sum + (trade.side === "sell" ? trade.value * (1 - feeOf(trade)) : -trade.value * (1 + feeOf(trade))), spareCash);
    if (left / totalValue > band + 1e-9) extra = fundBuys(weightTrades(within.filter((move) => move.target > move.current), totalValue), left, accountCurrency, fxFeeRate).trades;
  }
  const totals = tradeTotals([...funded.trades, ...extra], accountCurrency, fxFeeRate);
  return {
    tickers: funded.trades.map((trade) => trade.ticker),
    cashTo: extra.map((trade) => trade.ticker),
    totals: funded.scale < 1 ? { ...totals, buysScaled: Math.floor(funded.scale * 10_000) / 10_000 } : totals,
  };
}
