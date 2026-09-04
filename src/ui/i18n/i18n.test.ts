import { describe, expect, it } from "vitest";
import { createTranslator, resolveLocale, supportedLocales } from "./index";


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
});
