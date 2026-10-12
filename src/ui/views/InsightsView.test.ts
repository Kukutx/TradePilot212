import { describe, expect, it } from "vitest";
import { parseWindow } from "../../core/insights-service";
import { periodOf } from "./InsightsView";

describe("the period of a performance window", () => {
  const of = (period: "1m" | "3m" | "ytd" | "1y" | "all", now: string) => {
    const window = parseWindow({ period }, new Date(now));
    return periodOf({ ...(window.from ? { from: window.from.toISOString() } : {}), to: window.to.toISOString() });
  };

  it("reads each window back as the period it was asked for", () => {
    for (const period of ["1m", "3m", "ytd", "1y", "all"] as const) expect(of(period, "2026-10-12T03:00:00Z")).toBe(period);
  });

  it("doesn't take a month or three that happen to start on 1 January for the year to date", () => {
    expect(of("1m", "2027-01-31T00:20:00Z")).toBe("1m");
    expect(of("3m", "2027-04-02T00:40:00Z")).toBe("3m");
  });
});
