import type { PendingOrder, Position } from "../../shared/contracts";
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
