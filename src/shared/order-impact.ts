// What an order would change, worked out from the holdings and cash the review read: the holding's shares and share
// of the account, the cash left to trade, a sell's realized gain or loss as Trading 212 counts it, and the conversion
// fee at most. Estimates at the review's prices; nothing here reads anything or changes the order.

import type { AccountSummary, OrderImpact, OrderSide, Position } from "./contracts.js";
import { currencyOfAccount, knownCurrency } from "./trade-cost.js";

export interface OrderImpactInput {
  side: OrderSide;
  quantity: number;
  position?: Position | undefined;
  account: AccountSummary;
  /** The instrument's quote currency. */
  instrumentCurrency: string;
  /** The order's value in the account currency, when it is known. */
  accountNotional?: number | undefined;
  fxFeeRate: number;
  /** The tax year starts on 6 April, so the UK rules match the sales. */
  ukTaxYear: boolean;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const share = (value: number) => Math.round(value * 10_000) / 10_000;
const walletNumber = (position: Position | undefined, key: "currentValue" | "totalCost") => {
  const value = (position?.walletImpact as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export function orderImpact(input: OrderImpactInput): OrderImpact | undefined {
  const currency = input.account.currency;
  if (!currency || !(input.quantity > 0)) return undefined;
  const sharesBefore = Math.max(0, input.position?.quantity ?? 0);
  const sharesAfter = input.side === "buy" ? sharesBefore + input.quantity : Math.max(0, sharesBefore - input.quantity);
  const notional = input.accountNotional !== undefined && Number.isFinite(input.accountNotional) ? input.accountNotional : undefined;
  const converts = !knownCurrency(input.instrumentCurrency) || currencyOfAccount(input.instrumentCurrency) !== currencyOfAccount(currency);
  const fxFee = converts && notional !== undefined && input.fxFeeRate > 0 ? notional * input.fxFeeRate : undefined;

  // The holding at the broker's own valuation; what is left after a sell keeps its value per share, whatever the
  // order's price, and a buy adds what it pays. Without one, only a price in the account's own currency is used: a
  // price in pence is not pounds.
  const sameCurrency = input.instrumentCurrency.toUpperCase() === currency.toUpperCase();
  const heldValue = !sharesBefore ? 0 : walletNumber(input.position, "currentValue") ?? (sameCurrency && input.position?.currentPrice ? sharesBefore * input.position.currentPrice : undefined);
  const valueAfter = heldValue === undefined ? undefined
    : input.side === "buy" ? notional === undefined ? undefined : heldValue + notional
    : sharesBefore ? heldValue * (sharesAfter / sharesBefore) : 0;
  // The account's value moves only by the fee: cash becomes shares, or shares cash.
  const total = input.account.totalValue;
  const weights = total && total > 0 && heldValue !== undefined && valueAfter !== undefined
    ? { weightBefore: share(heldValue / total), weightAfter: share(valueAfter / (total - (fxFee ?? 0))) } : {};

  const cashBefore = input.account.cash?.availableToTrade;
  const cashAfter = cashBefore === undefined || notional === undefined ? undefined
    : input.side === "buy" ? cashBefore - notional - (fxFee ?? 0) : cashBefore + notional - (fxFee ?? 0);

  // Trading 212 counts a sale's gain against the holding's average price: the proceeds less the shares' part of its
  // cost. The conversion fee is a cost it reports apart, as the cash row counts it.
  const cost = walletNumber(input.position, "totalCost");
  const realized = input.side === "sell" && notional !== undefined && cost !== undefined && sharesBefore > 0
    ? notional - cost * (Math.min(input.quantity, sharesBefore) / sharesBefore) : undefined;

  return {
    currency,
    sharesBefore,
    sharesAfter,
    ...weights,
    ...(cashBefore === undefined ? {} : { cashBefore: cents(cashBefore) }),
    ...(cashAfter === undefined ? {} : { cashAfter: cents(cashAfter) }),
    ...(realized === undefined ? {} : { realized: cents(realized) }),
    ...(fxFee === undefined ? {} : { fxFee: cents(fxFee), fxFeeRate: input.fxFeeRate }),
    ...(input.ukTaxYear && input.side === "sell" ? { ukRule: realized !== undefined && realized < 0 ? "sell_loss" as const : "sell" as const } : {}),
  };
}
