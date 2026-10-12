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
      invalid: [], total: 65.5, cash: 10,
      save: { targets: [{ instrument: "VUSA", weight: 0.5 }, { instrument: "KO", weight: 0.155 }], cashWeight: 0.1, driftThreshold: 0.04, sellUntargeted: false },
    });
    // A target of 0 is no target.
    expect(readForm(form({ VUSA: "0", AAPL: "60" })).save?.targets).toEqual([{ instrument: "AAPL", weight: 0.6 }]);
    expect(readForm(form({ VUSA: "abc", AAPL: "10" }))).toMatchObject({ problem: "weight", invalid: ["VUSA"] });
    expect(readForm(form({ VUSA: "120" })).problem).toBe("weight");
    expect(readForm(form({ VUSA: "50" }, "-1")).problem).toBe("cash");
    expect(readForm(form({ VUSA: "50" }, "10", "0")).problem).toBe("threshold");
    expect(readForm(form({ VUSA: "", AAPL: "0" })).problem).toBe("none");
    expect(readForm(form(Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`T${index}`, "1"]))))).toMatchObject({ problem: "many" });
    expect(readForm(form({ VUSA: "60", AAPL: "35" }))).toMatchObject({ problem: "over", total: 95, cash: 10 });
    // Empty cash is whatever the targets leave, as the server reads it.
    const leftToCash = readForm(form({ VUSA: "60" }, ""));
    expect(leftToCash.cash).toBe(40);
    expect(leftToCash.save).not.toHaveProperty("cashWeight");
  });

  it("checks the weights as the server keeps them, to 0.01%", () => {
    // Below 0.005% the server keeps 0, which it refuses.
    expect(readForm(form({ VUSA: "0.004" })).problem).toBe("weight");
    // Three of 33.335% are kept as 33.34%: 100.02%.
    expect(readForm(form({ VUSA: "33.335", AAPL: "33.335", KO: "33.335" }, ""))).toMatchObject({ problem: "over" });
    // 99.995% and 0.005% are kept as 100% and 0.01%.
    expect(readForm(form({ VUSA: "99.995" }, "0.005")).problem).toBe("over");
    expect(readForm(form({ VUSA: "33.33", AAPL: "33.33", KO: "33.34" }, "")).problem).toBeUndefined();
    // Only the rows shown are read: a holding sold since the form opened is not saved.
    expect(readForm(form({ VUSA: "50", GONE: "10" }), ["VUSA"]).save?.targets).toEqual([{ instrument: "VUSA", weight: 0.5 }]);
  });

  it("fills the largest 20 when there are more holdings, leaving the others their share", () => {
    const many = data({ holdings: Array.from({ length: 24 }, (_, index) => holding(`T${index}`, 400 - index * 5)), cashWeight: 0.1 });
    const today = presetForm("today", many, "10");
    const filled = Object.entries(today.weights).filter(([, text]) => text !== "");
    expect(filled.map(([ticker]) => ticker)).toEqual(Array.from({ length: 20 }, (_, index) => `T${index}`));
    expect(readForm({ ...form(today.weights, today.cash) }).problem).toBeUndefined();
    // Equal weights share what the cash and the four left without a target leave.
    const rest = [20, 21, 22, 23].reduce((sum, index) => sum + (400 - index * 5) / 10_000, 0);
    const equal = presetForm("equal", many, "10");
    expect(Number(equal.weights.T0)).toBeCloseTo(Math.floor((0.9 - rest) / 20 * 10_000) / 100, 6);
    expect(equal.weights.T23).toBe("");
    expect(readForm({ ...form(equal.weights, equal.cash) }).problem).toBeUndefined();
    // The equal-risk weights fill the 20 the plan moves: the furthest from their equal-risk weight.
    const measured = many.holdings.reduce((sum, item) => sum + item.value, 0);
    const rows = many.holdings.map((item, index) => ({ ticker: item.ticker, weight: item.value / measured, volatility: 0.2, risk: 0, correlation: 0.5, parity: 1 / 24 + (index < 4 ? 0 : (index % 2 ? 0.002 : -0.002)) }));
    const parity = presetForm("parity", { ...many, risk: { rows } as AllocationAnalysis["risk"] }, "10");
    expect(Object.values(parity.weights).filter((text) => text !== "")).toHaveLength(20);
    expect(readForm({ ...form(parity.weights, parity.cash) }).problem).toBeUndefined();
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
    // The saved targets sell the holdings without one.
    expect(html).toContain("Targets 60.0% + cash 5.0% = 65.0%. 35.0% has no target; a rebalance sells the holdings without one.");
    expect(html).toContain(">Remove targets</button>");
    // Filled from the equal-risk weights, it says they are shares of the whole account.
    const rows = [{ ticker: "VUSA", weight: 2 / 3, volatility: 0.15, risk: 0.6, correlation: 0.9, parity: 0.5 }, { ticker: "AAPL", weight: 1 / 3, volatility: 0.3, risk: 0.4, correlation: 0.8, parity: 0.5 }];
    const parity = renderToStaticMarkup(createElement(TargetEditor, { data: data({ risk: { rows } as AllocationAnalysis["risk"] }), start: "parity", locale: "en", t: createTranslator("en"), onSave: async () => true, onClose: () => undefined }));
    expect(parity).toContain("as shares of the whole account");
    expect(parity).toContain(">Equal risk</button>");
    expect(parity).not.toContain("Remove targets");
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
