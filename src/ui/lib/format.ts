import type { Position } from "../../shared/contracts";
import { localeTag, type SupportedLocale } from "../i18n";

export interface MoneyOptions {
  /** Show "+" on gains and "−" on losses, never on zero. For P/L and changes only, not for balances. */
  signed?: boolean;
  /** Most decimals to show, for prices under 1 (default 2). */
  digits?: number;
}

export function money(value: number | undefined, currency: string, locale: SupportedLocale, options: MoneyOptions = {}): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const signDisplay = options.signed ? "exceptZero" : "auto";
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency,
      minimumFractionDigits: Math.min(2, options.digits ?? 2),
      maximumFractionDigits: options.digits ?? 2,
      signDisplay,
    }).format(value);
  } catch {
    const sign = options.signed && value > 0 ? "+" : "";
    return `${sign}${value.toFixed(options.digits ?? 2)} ${currency}`;
  }
}

/** A price or amount in its currency when one is known, otherwise a plain number. */
export function amount(value: number | undefined, currency: string | undefined, locale: SupportedLocale, options: MoneyOptions = {}): string {
  if (currency) return money(value, currency, locale, options);
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: options.digits ?? 2, signDisplay: options.signed ? "exceptZero" : "auto" }).format(value);
}

/**
 * An order's total value. London prices are quoted in pence (GBX); a total in pence runs to six
 * digits, so it is shown in pounds, which is exact (100 GBX = 1 GBP).
 */
export function notional(value: number | undefined, currency: string | undefined, locale: SupportedLocale): string {
  if (currency === "GBX" && value !== undefined) return money(value / 100, "GBP", locale);
  return amount(value, currency, locale);
}

export function num(value: number | undefined, locale: SupportedLocale, digits = 4): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
}

/**
 * Share quantities exactly as they are sent: Trading 212 takes up to 8 decimals, so a calculated
 * quantity and the one in the order editor always read the same.
 */
export function qty(value: number | undefined, locale: SupportedLocale): string {
  return num(value, locale, 8);
}

export function time(value: string | undefined, locale: SupportedLocale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** A calendar day such as "Oct 11, 2026" (or "Oct 11" without the year), read in UTC. */
export function dayLabel(value: string, locale: SupportedLocale, { year = true }: { year?: boolean } = {}): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : new Intl.DateTimeFormat(localeTag(locale), { ...(year ? { year: "numeric" } : {}), month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function dateTime(value: string | undefined, locale: SupportedLocale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function signedClass(value: number | undefined): string {
  if (!value) return "neutral";
  return value > 0 ? "positive" : "negative";
}

export function walletNumber(position: Position, key: string): number | undefined {
  const value = position.walletImpact?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pct(value: number | undefined, locale: SupportedLocale, digits = 1, options: MoneyOptions = {}): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: options.signed ? "exceptZero" : "auto",
  }).format(value);
}
