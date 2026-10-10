import type { AccountSummary, Instrument, OrderDraft, Position } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";

function positiveNumber(name: string, value?: number): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

export function resolveInstrumentFromList(instruments: Instrument[], query: string): Instrument {
  const norm = (value: string) => value.trim().toUpperCase();
  const q = norm(query);
  if (!q) throw new Error("Ticker, symbol, or instrument name is required");

  const exact = instruments.find((item) => norm(item.ticker) === q);
  if (exact) return exact;

  const symbols = instruments.filter((item) => {
    const ticker = norm(item.ticker);
    return norm(item.shortName ?? "") === q || ticker.startsWith(`${q}_`) || ticker.startsWith(`${q}-`);
  });
  if (symbols.length === 1) return symbols[0]!;
  if (symbols.length > 1) {
    const us = symbols.find((item) => /_US_EQ$/i.test(item.ticker));
    if (us) return us;
    const usd = symbols.filter((item) => norm(item.currencyCode) === "USD");
    if (usd.length === 1) return usd[0]!;
    throw new Error(`Symbol ${query} is ambiguous. Use an exact Trading 212 ticker: ${symbols.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }

  const exactNames = instruments.filter((item) => norm(item.name ?? "") === q);
  if (exactNames.length === 1) return exactNames[0]!;
  if (exactNames.length > 1) {
    const exactStocks = exactNames.filter((item) => norm(item.type ?? "") === "STOCK");
    if (exactStocks.length === 1) return exactStocks[0]!;
    const exactUsStocks = exactStocks.filter((item) => /_US_EQ$/i.test(item.ticker));
    if (exactUsStocks.length === 1) return exactUsStocks[0]!;
    const exactUsdStocks = exactStocks.filter((item) => norm(item.currencyCode) === "USD");
    if (exactUsdStocks.length === 1) return exactUsdStocks[0]!;
    throw new Error(`Instrument ${query} is ambiguous. Use an exact ticker: ${exactNames.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }

  const names = instruments.filter((item) => `${item.name ?? ""} ${item.shortName ?? ""}`.toUpperCase().includes(q));
  if (names.length === 1) return names[0]!;
  if (names.length > 1) {
    const stocks = names.filter((item) => norm(item.type ?? "") === "STOCK");
    if (stocks.length === 1) return stocks[0]!;
    const usStocks = stocks.filter((item) => /_US_EQ$/i.test(item.ticker));
    if (usStocks.length === 1) return usStocks[0]!;
    throw new Error(`Instrument ${query} is ambiguous. Use an exact ticker: ${names.slice(0, 8).map((item) => item.ticker).join(", ")}`);
  }
  throw new Error(`No Trading 212 instrument matched ${query}`);
}

export function validateOrderAgainstSnapshot(
  draft: OrderDraft,
  instrument: Instrument,
  position: Position | undefined,
  account: AccountSummary,
  config: Pick<RuntimeConfig, "maxOrderNotional" | "maxOrderQuantity">,
) {
  if (!draft.ticker.trim()) throw new Error("Ticker is required");
  positiveNumber("quantity", draft.quantity);

  if (config.maxOrderQuantity > 0 && draft.quantity > config.maxOrderQuantity)
    throw new Error(`Quantity exceeds MAX_ORDER_QUANTITY (${config.maxOrderQuantity})`);
  if (["limit", "stop_limit"].includes(draft.type)) positiveNumber("limitPrice", draft.limitPrice);
  if (["stop", "stop_limit"].includes(draft.type)) positiveNumber("stopPrice", draft.stopPrice);
  if (draft.extendedHours && draft.type !== "market")
    throw new Error("extendedHours is only supported for Market orders by the Trading 212 Public API");
  if (draft.extendedHours && !instrument.extendedHours)
    throw new Error(`${instrument.ticker} does not support extended-hours execution`);
  if (draft.side === "buy" && instrument.maxOpenQuantity && Math.max(0, position?.quantity ?? 0) + draft.quantity > instrument.maxOpenQuantity + Number.EPSILON)
    throw new Error(`Resulting quantity exceeds Trading 212 maxOpenQuantity (${instrument.maxOpenQuantity})`);
  if (draft.side === "sell" && draft.quantity > (position?.quantityAvailableForTrading ?? 0) + Number.EPSILON)
    throw new Error(`Sell quantity ${draft.quantity} exceeds available quantity ${position?.quantityAvailableForTrading ?? 0}`);

  // The broker's portfolio endpoint exposes quotes only for held instruments.
  // A model/user-supplied referencePrice must NOT authorize an uncapped market
  // buy of a new instrument when the configured notional estimate cap is on.
  if (draft.side === "buy" && config.maxOrderNotional > 0) {
    if (draft.type === "stop") {
      throw new Error("Buy Stop orders cannot enforce MAX_ORDER_NOTIONAL because fill price is unbounded. Use Stop-Limit instead.");
    }
    if (draft.type === "market" && !(Number.isFinite(position?.currentPrice) && (position?.currentPrice ?? 0) > 0)) {
      throw new Error("A broker-observed reference price is required for a capped Market buy of an unheld instrument. Use a Limit order to bound the execution price.");
    }
  }

  const price = draft.type === "limit" || draft.type === "stop_limit"
    ? draft.limitPrice
    : draft.type === "stop"
      ? draft.stopPrice
      : position?.currentPrice ?? draft.referencePrice;
  const estimatedNotional = price && price > 0 ? price * draft.quantity : undefined;

  if (config.maxOrderNotional > 0) {
    if (!estimatedNotional)
      throw new Error("A current referencePrice is required for this Market order while MAX_ORDER_NOTIONAL is enabled. Set MAX_ORDER_NOTIONAL=0 to disable the app-level notional cap.");
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) throw new Error("Estimated order notional is invalid");
    if (estimatedNotional > config.maxOrderNotional)
      throw new Error(`Estimated order notional ${estimatedNotional.toFixed(2)} ${instrument.currencyCode} exceeds MAX_ORDER_NOTIONAL (${config.maxOrderNotional})`);
  }

  const availableCash = account.cash?.availableToTrade;
  const sameCurrency = !!account.currency && account.currency.toUpperCase() === instrument.currencyCode.toUpperCase();
  const cashCheckApplied = draft.side !== "buy" || (sameCurrency && estimatedNotional !== undefined);
  if (draft.side === "buy" && sameCurrency && availableCash !== undefined && estimatedNotional !== undefined && estimatedNotional > availableCash)
    throw new Error(`Estimated order notional ${estimatedNotional.toFixed(2)} exceeds available cash ${availableCash.toFixed(2)} ${account.currency}`);

  return {
    ...(estimatedNotional === undefined ? {} : { estimatedNotional }),
    estimatedNotionalCurrency: instrument.currencyCode,
    cashCheckApplied,
    ...(availableCash === undefined ? {} : { availableCash }),
    ...(account.currency ? { accountCurrency: account.currency } : {}),
  };
}

