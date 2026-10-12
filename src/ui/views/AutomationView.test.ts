import { describe, expect, it } from "vitest";
import type { PriceAlert } from "../../shared/automation";
import { createTranslator } from "../i18n";
import { alertDayText } from "./AutomationView";

const alert = (fields: Partial<PriceAlert>): PriceAlert => ({ id: "alt_1", environment: "demo", ticker: "AAPL_US_EQ", condition: "day_move", percent: 3, createdAt: "2026-10-01T00:00:00Z", ...fields });

describe("automation alert rows", () => {
  it("gives a day's-move alert's last change from the previous close, and nothing for other alerts", () => {
    expect(alertDayText(alert({ lastDayChange: -0.0214 }), createTranslator("en"), "en")).toBe(" · on the day -2.14%");
    expect(alertDayText(alert({ lastDayChange: 0.031 }), createTranslator("zh-CN"), "zh-CN")).toBe(" · 当日 +3.10%");
    expect(alertDayText(alert({}), createTranslator("en"), "en")).toBe("");
    expect(alertDayText(alert({ condition: "trailing_drop", lastDayChange: 0.05 }), createTranslator("en"), "en")).toBe("");
  });
});
