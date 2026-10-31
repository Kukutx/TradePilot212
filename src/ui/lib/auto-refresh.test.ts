import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n";
import { ageText, IDLE_MS, LIVE_MS, readAutoRefresh, refreshDelay, saveAutoRefresh } from "./auto-refresh";

const en = createTranslator("en");
const zh = createTranslator("zh-CN");
const at = Date.parse("2026-10-30T14:00:00Z");

describe("the dashboard reading itself again", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads every minute while a holding's market is open, or while that is not known and something is held", () => {
    expect(refreshDelay({ open: true }, 3)).toBe(LIVE_MS);
    expect(refreshDelay({ open: false }, 3)).toBe(IDLE_MS);
    expect(refreshDelay(undefined, 3)).toBe(LIVE_MS);
    expect(refreshDelay({}, 0)).toBe(IDLE_MS);
    expect(LIVE_MS).toBe(60_000);
    expect(IDLE_MS).toBe(600_000);
  });

  it("says how long ago the dashboard was read, and marks it after a quarter of an hour", () => {
    const ago = (ms: number, t = en, locale: "en" | "zh-CN" = "en") => ageText(new Date(at - ms).toISOString(), at, locale, t);
    expect(ago(20_000)).toEqual({ text: "Just now", stale: false });
    expect(ago(3 * 60_000)).toEqual({ text: "3 minutes ago", stale: false });
    expect(ago(60_000)).toEqual({ text: "1 minute ago", stale: false });
    expect(ago(16 * 60_000)).toEqual({ text: "16 minutes ago", stale: true });
    expect(ago(2 * 3_600_000).text).toBe("2 hours ago");
    expect(ago(3 * 60_000, zh, "zh-CN").text).toBe("3分钟前");
    expect(ago(10_000, zh, "zh-CN").text).toBe("刚刚");
    // A day or more: the date and time.
    expect(ago(30 * 3_600_000).text).toMatch(/Oct 29/);
    // A clock a little ahead of the server's is "just now", not in the future.
    expect(ageText(new Date(at + 5000).toISOString(), at, "en", en).text).toBe("Just now");
    expect(ageText("not a time", at, "en", en)).toEqual({ text: "—", stale: false });
  });

  it("keeps the reader's choice, and stays on when the browser keeps nothing", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } });
    expect(readAutoRefresh()).toBe(true);
    saveAutoRefresh(false);
    expect(readAutoRefresh()).toBe(false);
    saveAutoRefresh(true);
    expect(readAutoRefresh()).toBe(true);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readAutoRefresh()).toBe(true);
    expect(() => saveAutoRefresh(false)).not.toThrow();
  });
});
