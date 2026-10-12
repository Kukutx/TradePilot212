import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AllocationAnalysis } from "../../shared/history";
import { createTranslator } from "../i18n";
import { AllocationView } from "../views/InsightsView";
import { canUseParity, presetForm, readForm, startingForm, TargetEditor, targetRows, type TargetForm } from "./target-editor";

const holding = (ticker: string, value: number) => ({ ticker, name: ticker, currency: "USD", value, weight: value / 10_000 });
const data = (extra: Partial<AllocationAnalysis> = {}) => ({
  kind: "allocation", environment: "demo", accountCurrency: "EUR", totalValue: 10_000, investedValue: 9000, cash: 1000, cashWeight: 0.1,
  holdings: [holding("VUSA", 5000), holding("AAPL", 2500), holding("KO", 1500)],
  byCurrency: [], byType: [], concentration: { largestWeight: 0.5, top5Weight: 1, herfindahl: 0.4, effectiveHoldings: 2.5 }, flags: [],
  ...extra,
} as unknown as AllocationAnalysis);
const drift = {
  threshold: 0.03, maxDrift: 0.1, over: true, savedAt: "2026-10-01T10:00:00Z", sellUntargeted: true,
  rows: [{ ticker: "VUSA", target: 0.4, current: 0.5, drift: 0.1 }, { ticker: "EIMI", target: 0.2, current: 0, drift: -0.2 }],
  cash: { target: 0.05, current: 0.1, drift: 0.05 }, untargeted: [{ ticker: "AAPL", current: 0.25 }, { ticker: "KO", current: 0.15 }],
};
const form = (weights: Record<string, string>, cash = "10", threshold = "5"): TargetForm => ({ weights, cash, threshold, sell: false });

describe("the target weights form", () => {
  it("opens on today's weights, or on the saved targets with the ones not held after the holdings", () => {
    expect(startingForm(data())).toEqual({ weights: { VUSA: "50", AAPL: "25", KO: "15" }, cash: "10", threshold: "5", sell: false });
    const saved = data({ drift });
    expect(targetRows(saved).map((row) => [row.ticker, row.held])).toEqual([["VUSA", true], ["AAPL", true], ["KO", true], ["EIMI", false]]);
    expect(startingForm(saved)).toEqual({ weights: { VUSA: "40", AAPL: "", KO: "", EIMI: "20" }, cash: "5", threshold: "3", sell: true });
  });

  it("fills equal weights from what the cash leaves, and never more than the account", () => {
    // 90% over three: 30% each.
    expect(presetForm("equal", data(), "10")).toEqual({ weights: { VUSA: "30", AAPL: "30", KO: "30" }, cash: "10" });
    // 100% over three is rounded down, to 33.33% each.
    const thirds = presetForm("equal", data(), "0");
    expect(thirds.weights.VUSA).toBe("33.33");
    expect(readForm({ ...form(thirds.weights, thirds.cash) }).problem).toBeUndefined();
    // A cash share that is not a number keeps today's.
    expect(presetForm("equal", data(), "lots").cash).toBe("10");
  });

  it("fills the equal-risk weights for the holdings measured and keeps the others and the cash", () => {
    const rows = [{ ticker: "VUSA", weight: 2 / 3, volatility: 0.15, risk: 0.6, correlation: 0.9, parity: 0.5 }, { ticker: "AAPL", weight: 1 / 3, volatility: 0.3, risk: 0.4, correlation: 0.8, parity: 0.5 }];
    const measured = data({ risk: { rows } as AllocationAnalysis["risk"] });
    expect(canUseParity(measured)).toBe(true);
    expect(canUseParity(data())).toBe(false);
    // VUSA and AAPL, 7,500 of 10,000 measured, split it evenly; KO stays at 15%.
    expect(presetForm("parity", measured, "10")).toEqual({ weights: { VUSA: "37.5", AAPL: "37.5", KO: "15" }, cash: "10" });
  });

  it("says what is wrong, and saves shares of the account with the threshold in points", () => {
    expect(readForm(form({ VUSA: "50", AAPL: "", KO: "15,5" }, "10", "4"))).toEqual({
      total: 65.5, cash: 10,
      save: { targets: [{ instrument: "VUSA", weight: 0.5 }, { instrument: "KO", weight: 0.155 }], cashWeight: 0.1, driftThreshold: 0.04, sellUntargeted: false },
    });
    // A target of 0 is no target.
    expect(readForm(form({ VUSA: "0", AAPL: "60" })).save?.targets).toEqual([{ instrument: "AAPL", weight: 0.6 }]);
    expect(readForm(form({ VUSA: "abc" })).problem).toBe("weight");
    expect(readForm(form({ VUSA: "120" })).problem).toBe("weight");
    expect(readForm(form({ VUSA: "50" }, "-1")).problem).toBe("cash");
    expect(readForm(form({ VUSA: "50" }, "10", "0")).problem).toBe("threshold");
    expect(readForm(form({ VUSA: "", AAPL: "0" })).problem).toBe("none");
    expect(readForm(form(Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`T${index}`, "1"]))))).toMatchObject({ problem: "many" });
    expect(readForm(form({ VUSA: "60", AAPL: "35" }))).toMatchObject({ problem: "over", total: 95, cash: 10 });
    // Empty cash is none.
    expect(readForm(form({ VUSA: "100" }, "")).save?.cashWeight).toBe(0);
  });

  it("shows each holding with today's share, the presets and the total", () => {
    const html = renderToStaticMarkup(createElement(TargetEditor, { data: data({ drift }), locale: "en", t: createTranslator("en"), onSave: async () => true, onClear: async () => true, onClose: () => undefined }));
    expect(html).toContain("Target weights");
    expect(html).toContain(">Today&#x27;s weights</button>");
    expect(html).toContain(">Equal weights</button>");
    // No equal-risk weights to fill from without risk by holding.
    expect(html).not.toContain(">Equal risk</button>");
    expect(html).toContain("Now 50.0%");
    expect(html).toContain("Not held");
    expect(html).toContain('aria-label="Target for VUSA"');
    expect(html).toContain("Targets 60.0% + cash 5.0% = 65.0%. 35.0% has no target; holdings without one stay as they are.");
    expect(html).toContain(">Remove targets</button>");
    expect(html).toContain('type="checkbox" checked=""');
  });

  it("offers to set targets on the Allocation tab, and to edit saved ones beside their drift", () => {
    const view = (extra: Partial<AllocationAnalysis>, withSave = true) => renderToStaticMarkup(createElement(AllocationView, {
      data: data(extra), locale: "en", t: createTranslator("en"), ...(withSave ? { onSaveTargets: async () => true, onClearTargets: async () => true } : {}),
    }));
    expect(view({})).toContain(">Set targets</button>");
    expect(view({})).toContain("No target weights are saved.");
    expect(view({ drift })).toContain(">Edit targets</button>");
    expect(view({ drift })).not.toContain(">Set targets</button>");
    // Without the means to save them, neither.
    expect(view({}, false)).not.toContain("Set targets");
    expect(view({ drift }, false)).not.toContain("Edit targets");
  });
});
