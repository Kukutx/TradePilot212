import { describe, expect, it } from "vitest";
import type { ActivityEvent, Instrument } from "../shared/contracts.js";
import { createConfig } from "./config.js";
import { LISTING_CHECK_EVERY_MS, listingOutcome, ListingWatches } from "./listing-watch.js";
import { notificationText } from "./notify.js";
import { MemoryStateStore } from "./state-store.js";

const start = new Date("2026-10-31T12:00:00Z");
const later = (ms: number) => new Date(start.getTime() + ms);
const at = (days: number) => new Date(start.getTime() - days * 86_400_000).toISOString();
const item = (ticker: string, days: number | undefined, type = "STOCK", currencyCode = "USD"): Instrument =>
  ({ ticker, name: `${ticker} Inc`, shortName: ticker, currencyCode, type, ...(days === undefined ? {} : { addedOn: at(days) }) });

function setup(environments: { demo?: boolean; live?: boolean } = { demo: true }) {
  const store = new MemoryStateStore();
  const config = createConfig({
    ...(environments.demo ? { T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" } : {}),
    ...(environments.live ? { T212_LIVE_API_KEY: "k", T212_LIVE_API_SECRET: "s" } : {}),
  });
  const events: ActivityEvent[] = [];
  const state = { instruments: [item("OLD", 400), item("RECENT", 3)] as Instrument[] | Error, reads: 0, during: undefined as (() => Promise<unknown>) | undefined };
  const trading = {
    instruments: async () => {
      state.reads++;
      const during = state.during;
      state.during = undefined;
      await during?.();
      if (state.instruments instanceof Error) throw state.instruments;
      return state.instruments;
    },
    recordActivity: async (type: ActivityEvent["type"], environment: ActivityEvent["environment"], details: Partial<ActivityEvent> = {}) => {
      const event = { id: String(events.length), timestamp: "", environment, type, ...details } as ActivityEvent;
      events.push(event);
      return event;
    },
  };
  return { watches: new ListingWatches({ config, store, trading }), events, state, store };
}

describe("listing alerts", () => {
  it("counts what is listed when it is turned on as seen, and notifies once for what Trading 212 adds after", async () => {
    const { watches, events, state } = setup();
    const watch = await watches.set({ environment: "demo", types: ["stock"], currencies: ["usd"] }, start);
    expect(watch).toMatchObject({ types: ["STOCK"], currencies: ["USD"], lastCheckedAt: start.toISOString() });
    // Within the hour: not read again.
    expect(await watches.check(later(10 * 60_000))).toEqual([]);
    state.instruments = [
      item("OLD", 400), item("RECENT", 3),
      // Dated before RECENT, but not seen before: a date alone does not say when it was first listed.
      item("BACKDATED", 5), item("NEWER", 0), item("ETF1", 0, "ETF"), item("EUR1", 0, "STOCK", "EUR"),
    ];
    const reports = await watches.check(later(LISTING_CHECK_EVERY_MS));
    expect(reports).toEqual([{ environment: "demo", action: "found", tickers: ["NEWER", "BACKDATED"], message: "NEWER Inc (NEWER); BACKDATED Inc (BACKDATED)" }]);
    expect(events).toHaveLength(1);
    expect(notificationText(events[0]!, "zh-CN")).toBe("[TradePilot 模拟] Trading 212 新上架 · NEWER Inc (NEWER); BACKDATED Inc (BACKDATED)");
    expect((await watches.get("demo"))).toMatchObject({ lastFound: 2, lastFoundAt: later(LISTING_CHECK_EVERY_MS).toISOString() });
    // The next hour finds nothing new; the instruments it did not match stay seen too.
    expect(await watches.check(later(2 * LISTING_CHECK_EVERY_MS))).toEqual([{ environment: "demo", action: "none", tickers: [], message: "Nothing new." }]);
    await watches.set({ environment: "demo" }, later(2 * LISTING_CHECK_EVERY_MS));
    expect(await watches.check(later(3 * LISTING_CHECK_EVERY_MS))).toMatchObject([{ action: "none" }]);
    expect(events).toHaveLength(1);
  });

  it("names one find by its ticker, cuts a long list short, and skips an account it cannot read", async () => {
    const { watches, events, state } = setup({ demo: true, live: true });
    await watches.set({ environment: "demo" }, start);
    await watches.set({ environment: "live" }, start);
    state.instruments = [item("RECENT", 3), item("ONE", 0)];
    await watches.check(later(LISTING_CHECK_EVERY_MS));
    expect(events.map((event) => [event.environment, event.ticker])).toEqual([["demo", "ONE"], ["live", "ONE"]]);
    state.instruments = new Error("Trading 212 is busy");
    expect(await watches.check(later(2 * LISTING_CHECK_EVERY_MS))).toEqual([
      { environment: "demo", action: "skipped", tickers: [], message: "Trading 212 is busy" },
      { environment: "live", action: "skipped", tickers: [], message: "Trading 212 is busy" },
    ]);
    const many = Array.from({ length: 30 }, (_, index) => item(`T${String(index).padStart(2, "0")}`, 0));
    const line = listingOutcome(many);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toMatch(/^T00 Inc \(T00\); .* \+\d+ more$/);
  });

  it("matches with the alert as it is after the read, when it was changed during it", async () => {
    const { watches, events, state } = setup();
    await watches.set({ environment: "demo", types: ["STOCK"] }, start);
    state.instruments = [item("RECENT", 3), item("STOCK1", 0), item("ETF1", 0, "ETF")];
    // The list arrives after the alert was changed to ETFs.
    state.during = () => watches.set({ environment: "demo", types: ["ETF"] }, start);
    expect(await watches.check(later(LISTING_CHECK_EVERY_MS))).toMatchObject([{ action: "found", tickers: ["ETF1"] }]);
    expect(events.map((event) => event.ticker)).toEqual(["ETF1"]);
  });

  it("refuses bad filters and an account without keys, and turns off cleanly", async () => {
    const { watches, store } = setup();
    await expect(watches.set({ environment: "demo", currencies: ["dollars"] })).rejects.toThrow("three-letter");
    await expect(watches.set({ environment: "demo", types: Array.from({ length: 11 }, (_, index) => `T${index}`) })).rejects.toThrow("at most 10");
    await expect(watches.set({ environment: "live" })).rejects.toThrow();
    await watches.set({ environment: "demo" }, start);
    expect(await watches.remove("demo")).toBe(true);
    expect(await watches.remove("demo")).toBe(false);
    expect(await store.list("listing-")).toEqual([]);
  });
});
