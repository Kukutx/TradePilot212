import { en, type MessageKey } from "./en";
import { zhCN } from "./zh-CN";

export const supportedLocales = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const messages: Record<SupportedLocale, Record<MessageKey, string>> = {
  en,
  "zh-CN": zhCN,
};

export function resolveLocale(input?: string | null): SupportedLocale {
  const value = (input ?? "").trim().toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  return "en";
}

export function localeTag(locale: SupportedLocale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

export function createTranslator(locale: SupportedLocale) {
  const dictionary = messages[locale] ?? messages.en;
  return (key: MessageKey): string => dictionary[key] ?? messages.en[key] ?? key;
}

export type { MessageKey };
