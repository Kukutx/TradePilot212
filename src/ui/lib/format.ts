import type { Position } from "../../shared/contracts";
import { localeTag, type SupportedLocale } from "../i18n";

export function money(value: number | undefined, currency: string, locale: SupportedLocale): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(localeTag(locale), {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function num(value: number | undefined, locale: SupportedLocale, digits = 4): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
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

export function pct(value: number | undefined, locale: SupportedLocale, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
