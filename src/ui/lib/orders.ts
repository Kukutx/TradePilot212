import type { OrderDraft, OrderResolution, OrderSizing, PendingOrder, Position, TradingEnvironment } from "../../shared/contracts";
import type { StopProtection } from "../../shared/protection";
import type { SupportedLocale } from "../i18n";
import { amount, money, pct, qty } from "./format";
import { instrumentLabel, orderCurrency, type InstrumentBook } from "./instruments";
import { fill, orderStatusLabel, orderTypeLabel, type Translator } from "./messages";

export interface PendingOrderSummary {
  ticker: string;
  name: string;
  /** The symbol under the name, empty when the name is the symbol. */
  detail: string;
  side: "buy" | "sell";
  /** "Limit $215.00", or "Stop Limit" with both prices in `prices`. */
  type: string;
  prices: string[];
  status?: string;
  quantity?: number;
  /** How far the trigger (stop) or limit price is from the holding's last price, e.g. "2.7% below the last price ($185.20)". */
  distance?: string;
}

/** A pending order as people read it: the instrument's name, the side, the order type with priced amounts, the status. */
export function summarizeOrder(order: PendingOrder, t: Translator, locale: SupportedLocale, positions: Position[] = [], book?: InstrumentBook): PendingOrderSummary {
  const ticker = typeof order.ticker === "string" ? order.ticker : "";
  const holding = positions.find((position) => position.instrument.ticker === ticker);
  const held = holding?.instrument;
  const embedded = order.instrument as { name?: unknown } | undefined;
  const label = instrumentLabel(ticker, book, held ?? (typeof embedded?.name === "string" ? { name: embedded.name } : undefined));
  const currency = orderCurrency(order, positions, book);
  const quantity = typeof order.quantity === "number" ? order.quantity : undefined;
  const side = String(order.side ?? "").toUpperCase() === "SELL" || (quantity ?? 0) < 0 ? "sell" : "buy";
  const price = (value: unknown) => (typeof value === "number" ? amount(value, currency, locale) : undefined);
  const stop = price(order.stopPrice);
  const limit = price(order.limitPrice);
  const typeName = orderTypeLabel(typeof order.type === "string" ? order.type : undefined, t);
  // A plain Limit or Stop order reads "Limit $215.00"; a Stop-Limit names both prices.
  const type = stop && limit ? typeName : [typeName, stop ?? limit].filter(Boolean).join(" ");
  const prices = stop && limit ? [`${t("stopPrice")} ${stop}`, `${t("limitPrice")} ${limit}`] : [];
  // Only held instruments have a last price: Trading 212 has no quote endpoint.
  const last = holding?.currentPrice;
  const trigger = typeof order.stopPrice === "number" ? order.stopPrice : typeof order.limitPrice === "number" ? order.limitPrice : undefined;
  const gap = trigger !== undefined && last && last > 0 ? (trigger - last) / last : undefined;
  const distance = gap === undefined ? undefined
    : fill(t(Math.abs(gap) < 0.0005 ? "orderAtLast" : gap < 0 ? "orderBelowLast" : "orderAboveLast"), { percent: pct(Math.abs(gap), locale, 1), price: amount(last, currency, locale) });
  return {
    ticker,
    name: label.name || ticker || "—",
    detail: label.detail,
    side,
    type,
    prices,
    ...(typeof order.status === "string" && order.status ? { status: orderStatusLabel(order.status, t) } : {}),
    ...(quantity === undefined ? {} : { quantity: Math.abs(quantity) }),
    ...(distance ? { distance } : {}),
  };
}

/** The highest sell stop and how far below the last price it sits: "$118.00 (8.3% below)". */
export function stopGuardText(guard: StopProtection, position: Position, locale: SupportedLocale, t: Translator): string {
  const price = money(guard.stopPrice, position.instrument.currencyCode, locale);
  if (guard.gap === undefined) return price;
  return fill(t(guard.gap < 0 ? "stopBelow" : "stopAbove"), { price, percent: pct(Math.abs(guard.gap), locale, 1) });
}

/** How much of the holding the sell stops would sell; a stop placed by amount leaves the shares unknown. */
export function stopCoverageText(guard: StopProtection, position: Position, locale: SupportedLocale, t: Translator): string {
  if (guard.coverage >= 1) return t("stopCoversAll");
  const values = { covered: qty(guard.covered, locale), quantity: qty(position.quantity, locale) };
  if (guard.unsized) return guard.covered > 0 ? fill(t("stopCoversAtLeast"), values) : t("stopCoversUnknown");
  return fill(t("stopCovers"), values);
}

export interface RiskAtStop {
  /** What the draft would lose at the stop, in the account currency; absent when the stop is not below the entry. */
  loss?: number;
  budget: number;
  over: boolean;
  cashCapped: boolean;
}

/**
 * For a risk-sized buy, what the draft as edited would lose at the stop: the quantity and the entry (limit,
 * stop or reference price) can change after sizing, so this follows them at the rate the sizing used.
 */
export function riskAtStop(draft: OrderDraft, resolution: OrderResolution | undefined): RiskAtStop | undefined {
  const risk = resolution?.risk;
  // Risk sizing is for buys; a draft switched to a sell no longer has a loss at the stop to show.
  if (!risk || resolution.sizing.mode !== "risk" || draft.side !== "buy") return undefined;
  const stop = resolution.sizing.stopLossPrice;
  // As the server sizes it: the limit, or the higher of the trigger or reference price and the last price.
  const given = draft.type === "limit" || draft.type === "stop_limit" ? draft.limitPrice : draft.type === "stop" ? draft.stopPrice : draft.referencePrice;
  const entry = draft.type === "limit" || draft.type === "stop_limit" ? given ?? risk.entryPrice
    : Math.max(...[given ?? risk.entryPrice, risk.currentPrice].filter((price): price is number => typeof price === "number" && Number.isFinite(price)));
  const base = { budget: risk.budget, cashCapped: !!risk.cashCapped };
  if (!(entry > stop) || !(risk.entryPrice > stop)) return { ...base, over: false };
  const loss = draft.quantity * (entry - stop) * (risk.perShare / (risk.entryPrice - stop));
  // A cent of rounding is not over the budget.
  return { ...base, loss, over: loss > risk.budget + 0.005 };
}

/** Sizing that reads the account (its cash, value or holding), so another account needs it worked out again. */
const ACCOUNT_SIZING: ReadonlySet<OrderSizing["mode"]> = new Set(["cash_percent", "position_percent", "all_available", "risk"]);

/**
 * The intent to size a draft again for another account, or undefined when its quantity carries over (an exact
 * quantity or an amount). The order's own fields come from the draft as edited; its reference price does not,
 * since that account's last price or quote is read afresh. Neither does an exchange rate: it is per unit of the
 * first account's currency, which the other account may not share.
 */
export function intentForAccount(draft: OrderDraft, resolution: OrderResolution | undefined, environment: TradingEnvironment): Record<string, unknown> | undefined {
  if (!resolution || !ACCOUNT_SIZING.has(resolution.sizing.mode)) return undefined;
  const sizing: Record<string, unknown> = { ...resolution.sizing };
  delete sizing.fxRateToInstrumentCurrency;
  return {
    environment,
    instrument: draft.ticker,
    side: draft.side,
    type: draft.type,
    sizing,
    ...(draft.limitPrice === undefined ? {} : { limitPrice: draft.limitPrice }),
    ...(draft.stopPrice === undefined ? {} : { stopPrice: draft.stopPrice }),
    ...(draft.timeValidity === undefined ? {} : { timeValidity: draft.timeValidity }),
    ...(draft.extendedHours === undefined ? {} : { extendedHours: draft.extendedHours }),
  };
}
