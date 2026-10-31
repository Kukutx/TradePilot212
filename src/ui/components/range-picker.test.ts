import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { PeriodSwitch } from "../views/InsightsView";
import { RangeContext, rangeLabel, rangeProblem, typedDay, type DateRange } from "./range-picker";

const t = createTranslator("en");
const noop = () => {};
const withRange = (range: DateRange | null) => renderToStaticMarkup(createElement(RangeContext.Provider, { value: { range, onRange: noop, onClear: noop, locale: "en" } },
  createElement(PeriodSwitch, { value: range ? null : "1m", onChange: noop, t, disabled: false })));

describe("a custom range", () => {
  it("is checked before it is read", () => {
    const today = "2026-10-30";
    expect(rangeProblem({ from: "2026-03-01", to: "2026-04-15" }, today)).toBeUndefined();
    expect(rangeProblem({ from: "2026-10-30", to: "2026-10-30" }, today)).toBeUndefined();
    expect(rangeProblem({ from: "", to: "2026-04-15" }, today)).toBe("rangeMissing");
    expect(rangeProblem({ from: "2026-04-16", to: "2026-04-15" }, today)).toBe("rangeOrder");
    expect(rangeProblem({ from: "2026-10-01", to: "2026-10-31" }, today)).toBe("rangeFuture");
    expect(rangeProblem({ from: "1999-12-31", to: "2026-01-01" }, today)).toBe("rangeEarly");
  });

  it("names its days, the year once when both share it", () => {
    expect(rangeLabel({ from: "2026-03-01", to: "2026-04-15" }, "en")).toBe("Mar 1 – Apr 15, 2026");
    expect(rangeLabel({ from: "2025-12-01", to: "2026-01-15" }, "en")).toBe("Dec 1, 2025 – Jan 15, 2026");
    expect(rangeLabel({ from: "2026-04-15", to: "2026-04-15" }, "en")).toBe("Apr 15, 2026");
    expect(rangeLabel({ from: "2026-03-01", to: "2026-04-15" }, "zh-CN")).toBe("3月1日 – 2026年4月15日");
  });

  it("sits beside the periods where a view can read one, and names the range chosen", () => {
    const off = withRange(null);
    expect(off).toContain('<div class="periodControls"><div class="segmented" role="radiogroup"');
    expect(off).toContain('class="rangeButton" aria-expanded="false"');
    expect(off).toContain('aria-label="Custom range"');
    const on = withRange({ from: "2026-03-01", to: "2026-04-15" });
    expect(on).toContain('class="rangeButton active"');
    expect(on).toContain('aria-label="Custom range: Mar 1 – Apr 15, 2026"');
    expect(on).toContain("<span>Mar 1 – Apr 15, 2026</span>");
    // No period is chosen while it holds.
    expect(on).not.toContain('aria-checked="true"');
    // Without a view that can read one, the switch is as it was.
    expect(renderToStaticMarkup(createElement(PeriodSwitch, { value: "1m", onChange: noop, t, disabled: false }))).not.toContain("rangeButton");
  });
  it("writes a day typed with slashes, dots or digits alone (a phone's number pad) as YYYY-MM-DD", () => {
    expect(typedDay("20261005")).toBe("2026-10-05");
    expect(typedDay("2026/10/05")).toBe("2026-10-05");
    expect(typedDay(" 2026.10.05 ")).toBe("2026-10-05");
    expect(typedDay("2026-10")).toBe("2026-10");
    expect(typedDay("2026100")).toBe("2026100");
  });
});
