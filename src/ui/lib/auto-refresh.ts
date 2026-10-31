// The dashboard reads itself again while it is looked at: every minute while a holding's market is open, every ten
// minutes otherwise. It waits while the page is hidden or scrolled out of view, while an order, cancellation or basket
// is being reviewed, and while anything else loads; a dashboard shown again from an old chat is not read until asked.
// Each read is the dashboard's own (Trading 212's account summary, positions and orders, shared for five seconds
// with any other read), so it adds at most one request a minute to each of those. Read-only: nothing here can trade.

import { useEffect, useRef, useState } from "react";
import type { PortfolioToday } from "../../shared/today";
import { localeTag, type SupportedLocale } from "../i18n";
import type { Translator } from "./messages";
import { dateTime } from "./format";

/** While a holding's market is open. */
export const LIVE_MS = 60_000;
/** While none is, or there is nothing held. */
export const IDLE_MS = 10 * 60_000;
/** A dashboard older than this says its figures may be out of date. */
export const STALE_MS = 15 * 60_000;
/** Reads that fail in a row before the widget stops reading by itself, and says why. */
export const MAX_FAILURES = 3;
/** How often the dashboard's age is written again. */
export const AGE_TICK_MS = 30_000;
const STORAGE_KEY = "tradepilot212.autoRefresh";

/**
 * How long after a read the next one is due: a minute while a holding's market is open, or while it is not known
 * whether one is (Trading 212 gave no schedule, or the day's moves were not read) and something is held; ten otherwise.
 */
export function refreshDelay(today: Pick<PortfolioToday, "open"> | undefined, holdings: number): number {
  if (today?.open === true) return LIVE_MS;
  if (today?.open === false) return IDLE_MS;
  return holdings > 0 ? LIVE_MS : IDLE_MS;
}

/** The reader's choice, kept in this browser; on unless they turned it off. Storage that cannot be read keeps it on. */
export function readAutoRefresh(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveAutoRefresh(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // A browser that keeps nothing asks again next time.
  }
}

/** How long ago `timestamp` was, in words: "Just now", "3 minutes ago", "2 hours ago", else the date and time. */
export function ageText(timestamp: string, now: number, locale: SupportedLocale, t: Translator): { text: string; stale: boolean } {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return { text: "—", stale: false };
  const age = Math.max(0, now - at);
  const stale = age > STALE_MS;
  if (age < 60_000) return { text: t("updatedJustNow"), stale };
  const words = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: "auto" });
  if (age < 3_600_000) return { text: words.format(-Math.floor(age / 60_000), "minute"), stale };
  if (age < 86_400_000) return { text: words.format(-Math.floor(age / 3_600_000), "hour"), stale };
  return { text: dateTime(timestamp, locale), stale };
}

/** The time now, written again every `everyMs`, for text that says how long ago something was. */
export function useNow(everyMs = AGE_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Whether the page is shown (not a background tab, a minimised window or a host that hid the frame). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

/** Whether any of `root` is on screen; a chat with several widgets reads only the ones in view. Without the observer, it is. */
function useInView(element: Element | null): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView;
}

/**
 * Calls `onTick` `delayMs` after `since` (the last read, or the last try), while `active` and the widget (`root`) is
 * shown and in view. Shown again after a while away, it reads at once if a read fell due meanwhile.
 */
export function useAutoRefresh(root: Element | null, { active, delayMs, since, onTick }: {
  active: boolean;
  delayMs: number;
  since: number;
  onTick: () => void | Promise<void>;
}): void {
  const visible = usePageVisible();
  const inView = useInView(root);
  const tick = useRef(onTick);
  tick.current = onTick;
  const running = active && visible && inView;
  useEffect(() => {
    if (!running || !Number.isFinite(since)) return;
    // At least a second, so a widget shown again does not read in the same moment as it reappears.
    const due = Math.max(1000, since + delayMs - Date.now());
    const timer = window.setTimeout(() => void tick.current(), due);
    return () => window.clearTimeout(timer);
  }, [running, delayMs, since]);
}
