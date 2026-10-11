import { describe, expect, it } from "vitest";
import { en } from "./en";
import { createTranslator, resolveLocale, supportedLocales } from "./index";
import { zhCN } from "./zh-CN";


describe("UI i18n", () => {
  it("resolves Chinese variants and falls back to English", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-TW")).toBe("zh-CN");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("it-IT")).toBe("en");
  });

  it("provides every key in every registered locale", () => {
    const english = createTranslator("en");
    for (const locale of supportedLocales) {
      const t = createTranslator(locale);
      for (const key of ["appName", "totalValue", "confirmLive", "mediumRisk"] as const) {
        expect(t(key)).toBeTruthy();
        expect(english(key)).toBeTruthy();
      }
    }
  });

  it("has the same keys and placeholders in both dictionaries", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect({ key, placeholders: placeholders(zhCN[key]) }).toEqual({ key, placeholders: placeholders(en[key]) });
    }
  });

  it("writes the environments as words in Chinese, not as English codes", () => {
    for (const [key, text] of Object.entries(zhCN)) {
      expect({ key, text, code: /\b(LIVE|DEMO)\b/.test(text) }).toEqual({ key, text, code: false });
    }
    expect(zhCN.demo).toBe("模拟盘");
    expect(zhCN.live).toBe("实盘");
  });

  it("keeps singular and plural count messages in pairs", () => {
    for (const key of Object.keys(en)) {
      if (!/One$/.test(key) || !key.startsWith("count")) continue;
      expect(Object.keys(en)).toContain(key.replace(/One$/, "Other"));
    }
  });
});
