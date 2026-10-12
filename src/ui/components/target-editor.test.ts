import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AllocationAnalysis, HoldingCovariance, HoldingCovariancePayload } from "../../shared/history";
import { targetRiskOf } from "../../shared/holding-risk";
import { createTranslator } from "../i18n";
import { AllocationView } from "../views/InsightsView";
import { holdEnter } from "./instrument-search";
import { awayPending, canUseParity, covarianceFits, covarianceKey, loadCovariance, presetForm, readForm, riskOfForm, savedAway, startingForm, TargetEditor, TargetRiskSummary, targetRows, typedTargets, widenedState, type TargetForm } from "./target-editor";

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

  it("reads the targets typed as the server keeps them, for the risk at them", () => {
    const typed = typedTargets(form({ VUSA: "40", AAPL: "", KO: "0", EIMI: "abc", BIG: "120", TINY: "0.004", ODD: "12,35" }), ["VUSA", "AAPL", "KO", "EIMI", "BIG", "TINY", "ODD"]);
    expect([...typed]).toEqual([["VUSA", 0.4], ["ODD", 0.1235]]);
    // Only the rows shown.
    expect([...typedTargets(form({ VUSA: "40", GONE: "10" }), ["VUSA"])]).toEqual([["VUSA", 0.4]]);
  });

  const covariance: HoldingCovariance = { tickers: ["VUSA", "AAPL", "KO"], matrix: [[0.04, 0.02, 0.005], [0.02, 0.09, 0.004], [0.005, 0.004, 0.0225]] };
  const measured = { rows: covariance.tickers.map((ticker) => ({ ticker, weight: 1 / 3, volatility: 0.2, risk: 1 / 3, correlation: 0.5 })), to: "2026-10-09", weeks: 51 };
  const summary = (props: Partial<Parameters<typeof TargetRiskSummary>[0]>, locale: "en" | "zh-CN" = "en") =>
    renderToStaticMarkup(createElement(TargetRiskSummary, { state: { state: "read", covariance, asked: [] }, weeks: 51, locale, t: createTranslator(locale), ...props }));

  it("shows the volatility now and at the targets, and the whole account's when it can", () => {
    const holdings = data().holdings;
    const risk = targetRiskOf(covariance, holdings, new Map([["VUSA", 0.3], ["AAPL", 0.3], ["KO", 0.3]]), false, 0.1)!;
    const html = summary({ risk });
    expect(html).toContain("Risk at these targets");
    expect(html).toContain(">Holdings and targets measured, together</th>");
    expect(html).toContain(">Whole account, cash included</th>");
    expect(html).toContain("From the 51 weeks of closes");
    expect(html).toContain('<p role="status" class="visuallyHidden">The risk at these targets is worked out as you type.</p>');
    expect(html).not.toContain("Not measured");
    expect(html).not.toContain("near, not quite, equal");
    expect(summary({ risk, parity: true })).toContain("near, not quite, equal");
    // A target not held is not measured: no whole-account figure, and it is named.
    const without = summary({ risk: targetRiskOf(covariance, holdings, new Map([["VUSA", 0.3], ["EIMI", 0.2]]), false)! });
    expect(without).not.toContain("Whole account");
    expect(without).toContain("Not measured, so left out: EIMI.");
    // Why there are no figures, said where a screen reader hears it.
    expect(summary({ state: { state: "reading" } })).toContain('<p role="status" class="panelNote">Reading the holdings');
    expect(summary({ state: { state: "reading" } })).toContain('aria-busy="true"');
    expect(summary({ state: { state: "none" } }, "zh-CN")).toContain("读不到这组目标下的风险");
    expect(summary({ state: { state: "stale" } })).toContain("The holdings&#x27; risk read now doesn&#x27;t match the one on this page");
    expect(summary({ risk: "invalid" })).toContain("A target or the cash share typed isn&#x27;t a valid share");
    expect(summary({ risk: "unmeasured" })).toContain("None of the holdings measured has a share at these targets");
    expect(summary({ risk: "invalid" })).not.toContain("<table");
  });

  it("works the risk out from the form: the shares typed, the holdings kept or sold, and the cash", () => {
    const holdings = data().holdings;
    const tickers = ["VUSA", "AAPL", "KO"];
    // AAPL and KO kept at their 25% and 15%, as the shared function has it, with the cash typed.
    const kept = riskOfForm(covariance, holdings, form({ VUSA: "40", AAPL: "", KO: "" }, "20"), tickers);
    expect(kept).toEqual(targetRiskOf(covariance, holdings, new Map([["VUSA", 0.4]]), false, 0.2));
    // 40 + 25 + 15 and 20% cash make the whole account; with 30% cash, or the 60% the target leaves, they make more.
    expect(typeof kept === "object" && kept.account).toBeTruthy();
    const over = riskOfForm(covariance, holdings, form({ VUSA: "40", AAPL: "", KO: "" }, "30"), tickers);
    expect(typeof over === "object" && over.account).toBeUndefined();
    const leftover = riskOfForm(covariance, holdings, form({ VUSA: "40", AAPL: "", KO: "" }, ""), tickers);
    expect(typeof leftover === "object" && leftover.account).toBeUndefined();
    // Sold, only VUSA is left.
    const sold = riskOfForm(covariance, holdings, { ...form({ VUSA: "40", AAPL: "", KO: "" }, ""), sell: true }, tickers);
    expect(typeof sold === "object" && sold.atTargets.volatility).toBeCloseTo(0.2, 10);
    expect(riskOfForm(covariance, holdings, form({ VUSA: "600", AAPL: "", KO: "" }), tickers)).toBe("invalid");
    // A cash share that is not one is no whole account either.
    expect(riskOfForm(covariance, holdings, form({ VUSA: "40", AAPL: "", KO: "" }, "abc"), tickers)).toBe("invalid");
    expect(riskOfForm(covariance, holdings, form({ VUSA: "40", AAPL: "", KO: "" }, "-30"), tickers)).toBe("invalid");
    expect(riskOfForm(covariance, holdings, { ...form({ VUSA: "", AAPL: "", KO: "", EIMI: "50" }), sell: true }, [...tickers, "EIMI"])).toBe("unmeasured");
  });

  it("uses only a covariance read for the holdings and the weeks on screen", async () => {
    const payload = { kind: "holding_covariance" as const, environment: "demo" as const, covariance, weeks: 51, to: "2026-10-09" };
    expect(covarianceFits(payload, measured)).toBe(true);
    expect(covarianceFits({ ...payload, weeks: 50 }, measured)).toBe(false);
    expect(covarianceFits({ ...payload, to: "2026-10-02" }, measured)).toBe(false);
    expect(covarianceFits({ ...payload, covariance: { tickers: ["VUSA", "AAPL"], matrix: [[0.04, 0.02], [0.02, 0.09]] } }, measured)).toBe(false);
    const shown: unknown[] = [];
    const load = (read: () => Promise<HoldingCovariancePayload>, open = true) => loadCovariance(read, measured, [], () => open, (state) => shown.push(state));
    let asked = 0;
    await load(async () => { asked += 1; return payload; });
    expect(asked).toBe(1);
    await load(async () => ({ ...payload, weeks: 50 }));
    await load(async () => ({ kind: "holding_covariance", environment: "demo", problem: "No quote provider" }));
    await load(async () => { throw new Error("offline"); });
    expect(shown).toEqual([{ state: "read", covariance, asked: [] }, { state: "stale" }, { state: "none" }, { state: "none" }]);
    // Closed before the read came back: nothing is shown.
    await load(async () => payload, false);
    expect(shown).toHaveLength(4);
  });

  it("reads the covariance again after a Refresh, for the holdings and weeks on screen", () => {
    const shown = data({ risk: measured as AllocationAnalysis["risk"], timestamp: "2026-10-12T16:00:00Z" });
    // A Refresh brings a new read time: the form reads again, and a read that fits comes from the App's cache.
    expect(covarianceKey(shown)).not.toBe(covarianceKey({ ...shown, timestamp: "2026-10-12T16:05:00Z" }));
    expect(covarianceKey({ ...shown, risk: { ...shown.risk!, weeks: 50 } })).not.toBe(covarianceKey(shown));
    expect(covarianceKey({ ...shown, risk: { ...shown.risk!, rows: shown.risk!.rows.slice(0, 2) } })).not.toBe(covarianceKey(shown));
    expect(covarianceKey(data())).toBe("");
  });

  it("reads the covariance as the form opens, only with risk by holding", () => {
    const pending = () => new Promise<HoldingCovariancePayload>(() => undefined);
    const opening = renderToStaticMarkup(createElement(TargetEditor, { data: data({ risk: measured as AllocationAnalysis["risk"] }), locale: "en", t: createTranslator("en"), onSave: async () => true, onReadCovariance: pending, onClose: () => undefined }));
    expect(opening).toContain("Reading the holdings");
    expect(renderToStaticMarkup(createElement(TargetEditor, { data: data(), locale: "en", t: createTranslator("en"), onSave: async () => true, onReadCovariance: pending, onClose: () => undefined }))).not.toContain("Risk at these targets");
    expect(renderToStaticMarkup(createElement(TargetEditor, { data: data({ risk: measured as AllocationAnalysis["risk"] }), locale: "en", t: createTranslator("en"), onSave: async () => true, onClose: () => undefined }))).not.toContain("Risk at these targets");
  });

  it("says when the holdings kept without a target take the account past 100%", () => {
    const editor = (weights: Record<string, string>, sell = false) => renderToStaticMarkup(createElement(TargetEditor, {
      data: data({ drift: { ...drift, rows: Object.entries(weights).map(([ticker, target]) => ({ ticker, target: Number(target) / 100, current: 0, drift: 0 })), cash: { target: 0.1, current: 0.1, drift: 0 }, sellUntargeted: sell } }),
      locale: "en", t: createTranslator("en"), onSave: async () => true, onClose: () => undefined,
    }));
    // VUSA 60% and AAPL 30% with 10% cash leave nothing for KO's 15%, kept.
    expect(editor({ VUSA: "60", AAPL: "30" })).toContain("The holdings without a target are kept (15.0%), so with them the targets and cash come to 115.0%: a rebalance can&#x27;t reach every target.");
    expect(editor({ VUSA: "60", AAPL: "30" }, true)).not.toContain("are kept (");
    expect(editor({ VUSA: "50", AAPL: "25" })).not.toContain("are kept (");
  });

  it("takes instruments not held after the holdings, once each, and gives them a share only with equal weights", () => {
    const saved = data({ drift });
    expect(savedAway(saved)).toEqual([{ ticker: "EIMI" }]);
    // Added from the search: after the saved one; a holding, or one already there, is not taken twice.
    const away = [...savedAway(saved), { ticker: "NEW", name: "New Co" }, { ticker: "VUSA" }, { ticker: "NEW" }];
    expect(targetRows(saved, away).map((row) => [row.ticker, row.held, row.name])).toEqual([["VUSA", true, "VUSA"], ["AAPL", true, "AAPL"], ["KO", true, "KO"], ["EIMI", false, undefined], ["NEW", false, "New Co"]]);
    // Removed, the saved one is no row, so it is not saved.
    expect(targetRows(saved, []).map((row) => row.ticker)).toEqual(["VUSA", "AAPL", "KO"]);
    // Equal weights share what the cash leaves among all five; today's weights and the equal-risk ones give them none.
    expect(presetForm("equal", saved, "10", away).weights).toEqual({ VUSA: "18", AAPL: "18", KO: "18", EIMI: "18", NEW: "18" });
    expect(presetForm("today", saved, "10", away).weights).toMatchObject({ EIMI: "", NEW: "" });
    // With more than a target list takes, the ones not held come first: they were put there to be bought.
    const many = data({ holdings: Array.from({ length: 24 }, (_, index) => holding(`T${index}`, 400 - index * 5)) });
    const crowded = presetForm("equal", many, "10", [{ ticker: "NEW" }]);
    expect(crowded.weights.NEW).not.toBe("");
    expect(Object.values(crowded.weights).filter((text) => text !== "")).toHaveLength(20);
    expect(crowded.weights.T18).not.toBe("");
    expect(crowded.weights.T19).toBe("");
    expect(readForm(form(crowded.weights, crowded.cash)).problem).toBeUndefined();
  });

  it("uses a covariance with instruments not held only when they were asked for, and says which are still to come", () => {
    const payload = { kind: "holding_covariance" as const, environment: "demo" as const, weeks: 51, to: "2026-10-09",
      covariance: { tickers: [...covariance.tickers, "EIMI"], matrix: [[0.04, 0.02, 0.005, 0.01], [0.02, 0.09, 0.004, 0.01], [0.005, 0.004, 0.0225, 0.01], [0.01, 0.01, 0.01, 0.03]] } };
    expect(covarianceFits(payload, measured, ["EIMI", "NEW"])).toBe(true);
    // Not asked for: it is not the read the form made.
    expect(covarianceFits(payload, measured)).toBe(false);
    expect(covarianceFits({ ...payload, covariance: { ...payload.covariance, tickers: ["VUSA", "AAPL", "EIMI", "EIMI"] } }, measured, ["EIMI"])).toBe(false);
    const read = { state: "read" as const, covariance: { ...payload.covariance, unmeasured: [{ ticker: "LATE", reason: "later" as const }, { ticker: "ODD", reason: "short" as const }] }, asked: ["EIMI", "LATE", "ODD"] };
    const pending = awayPending(read, ["EIMI", "LATE", "NEW", "ODD"]);
    expect([...pending.reading]).toEqual(["NEW"]);
    expect([...pending.later]).toEqual(["LATE"]);
    expect([...awayPending({ state: "reading" }, ["NEW"]).reading]).toEqual([]);
    // A read for more that falls short keeps the figures in hand and leaves the new ones to a Refresh.
    const before = { state: "read" as const, covariance: payload.covariance, asked: ["EIMI"] };
    const kept = widenedState(before, { state: "none" }, ["EIMI", "NEW"]);
    expect(kept).toEqual({ ...before, asked: ["EIMI", "NEW"], failed: ["NEW"] });
    expect([...awayPending(kept, ["EIMI", "NEW"]).later]).toEqual(["NEW"]);
    expect([...awayPending(kept, ["EIMI", "NEW"]).reading]).toEqual([]);
    expect(widenedState(before, { state: "stale" }, ["EIMI", "NEW"])).toMatchObject({ state: "read", failed: ["NEW"] });
    // One that fits takes over; with nothing in hand, the read's state is the form's.
    const wider = { state: "read" as const, covariance: payload.covariance, asked: ["EIMI", "NEW"] };
    expect(widenedState(kept, wider, ["EIMI", "NEW"])).toBe(wider);
    expect(widenedState({ state: "reading" }, { state: "none" }, ["NEW"])).toEqual({ state: "none" });
    // In the summary: the ones still being read, the ones a Refresh reads, and the rest, each said once.
    const risk = targetRiskOf(read.covariance, data().holdings, new Map([["VUSA", 0.3], ["EIMI", 0.1], ["NEW", 0.1], ["LATE", 0.1], ["ODD", 0.1]]), false)!;
    expect(risk.leftOut).toEqual(["NEW", "LATE", "ODD"]);
    const html = summary({ risk, state: read, pending });
    expect(html).toContain("Reading the closes of NEW to count them…");
    expect(html).toContain("The closes of LATE weren&#x27;t read this time; press Refresh to count them.");
    expect(html).toContain("Not measured, so left out: ODD.");
    expect(html).toContain('aria-busy="true"');
    const zh = summary({ risk, state: read, pending }, "zh-CN");
    expect(zh).toContain("正在读取 NEW 的收盘价，读完后计入…LATE 的收盘价还没读到，点“刷新”后计入。未测算，未计入：ODD。");
  });

  it("says when a target list cannot take every row, and stops adding at 20 targets not held", () => {
    const editor = (extra: Partial<AllocationAnalysis>) => renderToStaticMarkup(createElement(TargetEditor, { data: data(extra), locale: "en", t: createTranslator("en"), onSave: async () => true, onSearch: async () => [], onClose: () => undefined }));
    const rows = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ ticker: `X${index + from}`, target: 0.01, current: 0, drift: -0.01 }));
    // 18 holdings and five targets not held: equal weights leave three holdings without a target, and say so.
    const eighteen = Array.from({ length: 18 }, (_, index) => holding(`H${index}`, 400 - index * 5));
    expect(editor({ holdings: eighteen, drift: { ...drift, rows: rows(5), sellUntargeted: false } })).toContain("A target list takes 20: equal weights fill the targets you don&#x27;t hold first, so the 3 smallest holdings get none and stay as they are.");
    expect(editor({ holdings: eighteen, drift: { ...drift, rows: rows(5), sellUntargeted: true } })).toContain("so the 3 smallest holdings get none and a rebalance sells them.");
    // More holdings than that: the presets' note, which says where the targets not held go.
    const many = Array.from({ length: 22 }, (_, index) => holding(`H${index}`, 400 - index * 5));
    expect(editor({ holdings: many, drift: { ...drift, rows: rows(1), sellUntargeted: false } })).toContain("A target list takes 20 holdings: the presets fill the 20 largest (for equal weights, after the targets you don&#x27;t hold;");
    expect(editor({ holdings: eighteen, drift: { ...drift, rows: rows(2), sellUntargeted: false } })).not.toContain("A target list takes 20");
    // Twenty not held: the search gives way to a note.
    const full = editor({ drift: { ...drift, rows: rows(20), sellUntargeted: false } });
    expect(full).toContain("A target list takes 20: remove a target you don&#x27;t hold to add another.");
    expect(full).not.toContain("Add a target you don&#x27;t hold");
    expect(editor({ drift: { ...drift, rows: rows(19), sellUntargeted: false } })).toContain("Add a target you don&#x27;t hold");
  });

  it("keeps Enter in the search from saving the form", () => {
    let held = 0;
    holdEnter({ key: "Enter", preventDefault: () => { held += 1; } });
    holdEnter({ key: "a", preventDefault: () => { held += 1; } });
    expect(held).toBe(1);
  });

  it("offers a search for targets not held, and a way to remove them, when connected", () => {
    const search = async () => [];
    const html = renderToStaticMarkup(createElement(TargetEditor, { data: data({ drift }), locale: "en", t: createTranslator("en"), onSave: async () => true, onSearch: search, onClose: () => undefined }));
    expect(html).toContain("Add a target you don&#x27;t hold");
    expect(html).toContain('aria-label="Remove EIMI from the targets"');
    // Holdings are removed by leaving their share empty, not by a button.
    expect(html).not.toContain("Remove VUSA from the targets");
    expect(renderToStaticMarkup(createElement(TargetEditor, { data: data({ drift }), locale: "en", t: createTranslator("en"), onSave: async () => true, onClose: () => undefined }))).not.toContain("Add a target");
    expect(renderToStaticMarkup(createElement(TargetEditor, { data: data({ drift }), locale: "zh-CN", t: createTranslator("zh-CN"), onSave: async () => true, onSearch: search, onClose: () => undefined })))
      .toContain('aria-label="从目标中移除 EIMI"');
  });

  it("says beside the drift what volatility the saved targets would give", () => {
    const volatility = { now: 0.182, atTargets: 0.151, account: { now: 0.164, atTargets: 0.143 } };
    const html = renderToStaticMarkup(createElement(AllocationView, { data: data({ drift: { ...drift, volatility } }), locale: "en", t: createTranslator("en") }));
    expect(html).toContain("At these targets the holdings and targets measured would move 15.1% a year together (18.2% now). The whole account, cash included: 14.3% (16.4% now).");
    const zh = renderToStaticMarkup(createElement(AllocationView, { data: data({ drift: { ...drift, volatility: { now: 0.182, atTargets: 0.151 } } }), locale: "zh-CN", t: createTranslator("zh-CN") }));
    expect(zh).toContain("按这组目标，已测算的持仓和目标合计年化波动 15.1%（现在 18.2%）。");
    expect(zh).not.toContain("整个账户（含现金）");
    // Chinese sentences follow each other without a space.
    expect(renderToStaticMarkup(createElement(AllocationView, { data: data({ drift: { ...drift, volatility } }), locale: "zh-CN", t: createTranslator("zh-CN") })))
      .toContain("（现在 18.2%）。整个账户（含现金）：14.3%（现在 16.4%）。");
  });
});
