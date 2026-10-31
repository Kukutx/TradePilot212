// Listing alerts: the scheduler reads each watched account's instrument list at most once an hour and writes a
// new_listings activity event (and webhook, when configured) when Trading 212 has added instruments of the chosen
// types and currencies. An instrument is new when Trading 212 dates it in the last two weeks and the alert has not
// seen it: a date alone could be earlier than the read that first lists it. Alerts never place orders.

import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import { LISTING_WATCH_DAYS, MAX_WATCH_FILTERS, type ListingWatch } from "../shared/listings.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

/** How often a watch reads the instrument list; Trading 212 allows it about once a minute, and lists change slowly. */
export const LISTING_CHECK_EVERY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const watchKey = (environment: TradingEnvironment) => `listing-watch:${environment}`;
/** The tickers dated in the window that a watch has seen, kept apart so the watch itself stays small. */
const seenKey = (environment: TradingEnvironment) => `listing-seen:${environment}`;

export interface ListingWatchInput {
  environment: TradingEnvironment;
  types?: string[];
  currencies?: string[];
}

export interface ListingReport {
  environment: TradingEnvironment;
  action: "found" | "none" | "skipped";
  tickers: string[];
  message: string;
}

const codes = (values: string[] | undefined, field: string) => {
  const unique = [...new Set((values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (unique.length > MAX_WATCH_FILTERS) fail("INVALID_INPUT", `A listing alert narrows to at most ${MAX_WATCH_FILTERS} ${field}`, { field });
  return unique.sort();
};

/** Instruments Trading 212 dates in the window ending at `now` (and up to a day ahead of it). */
export function recentlyDated(instruments: Instrument[], now: Date, days = LISTING_WATCH_DAYS): Instrument[] {
  const start = now.getTime() - days * DAY_MS;
  return instruments.filter((item) => {
    const at = item.addedOn ? Date.parse(item.addedOn) : Number.NaN;
    return Number.isFinite(at) && at >= start && at <= now.getTime() + DAY_MS;
  });
}

export function watchMatches(watch: Pick<ListingWatch, "types" | "currencies">, item: Instrument): boolean {
  return (!watch.types.length || watch.types.includes(item.type?.toUpperCase() || "OTHER"))
    && (!watch.currencies.length || watch.currencies.includes(item.currencyCode?.toUpperCase() ?? ""));
}

/** One line for the alert: the names, newest first, cut short with how many more. */
export function listingOutcome(found: Instrument[]): string {
  const names = found.map((item) => `${item.name || item.shortName || item.ticker} (${item.shortName || item.ticker})`);
  let line = "";
  for (const [index, name] of names.entries()) {
    const more = names.length - index - 1;
    const next = line ? `${line}; ${name}` : name;
    if (next.length + (more ? ` +${more} more`.length : 0) > 200) return `${line}${line ? " " : ""}+${names.length - index} more`;
    line = next;
  }
  return line;
}

export class ListingWatches {
  constructor(private readonly deps: {
    config: RuntimeConfig;
    store: StateStore;
    trading: Pick<TradingService, "instruments" | "recordActivity">;
  }) {}

  async get(environment: TradingEnvironment): Promise<ListingWatch | undefined> {
    return this.deps.store.get<ListingWatch>(watchKey(environment));
  }

  async list(): Promise<ListingWatch[]> {
    return (await this.deps.store.list<ListingWatch>("listing-watch:")).map((entry) => entry.value);
  }

  /** Start or change the alert. What is listed now counts as seen, so the first notice is for what comes next. */
  async set(input: ListingWatchInput, now = new Date()): Promise<ListingWatch> {
    requireCredentials(this.deps.config, input.environment);
    const types = codes(input.types, "types");
    const currencies = codes(input.currencies, "currencies");
    if (currencies.some((code) => !/^[A-Z]{3}$/.test(code))) fail("INVALID_INPUT", "Currencies are three-letter codes, such as USD", { field: "currencies" });
    const current = await this.get(input.environment);
    if (!current) {
      const seen = recentlyDated(await this.deps.trading.instruments(input.environment), now).map((item) => item.ticker);
      await this.deps.store.put(seenKey(input.environment), seen);
    }
    const watch: ListingWatch = {
      ...(current ?? {}),
      environment: input.environment,
      types,
      currencies,
      createdAt: current?.createdAt ?? now.toISOString(),
      ...(current ? {} : { lastCheckedAt: now.toISOString() }),
    };
    await this.deps.store.put(watchKey(input.environment), watch);
    return watch;
  }

  async remove(environment: TradingEnvironment): Promise<boolean> {
    const had = !!(await this.get(environment));
    await this.deps.store.delete(watchKey(environment));
    await this.deps.store.delete(seenKey(environment));
    return had;
  }

  /** One scheduler pass: each watch whose hour is up reads the list once and notifies about what it had not seen. */
  async check(now = new Date()): Promise<ListingReport[]> {
    const reports: ListingReport[] = [];
    for (const watch of await this.list()) {
      const { environment } = watch;
      if (!credentialStatus(this.deps.config)[environment]) continue;
      if (watch.lastCheckedAt && now.getTime() - Date.parse(watch.lastCheckedAt) < LISTING_CHECK_EVERY_MS) continue;
      let instruments: Instrument[];
      try {
        instruments = await this.deps.trading.instruments(environment);
      } catch (error) {
        // The next tick tries again; the other account's watch still runs.
        reports.push({ environment, action: "skipped", tickers: [], message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const recent = recentlyDated(instruments, now);
      const seen = new Set((await this.deps.store.get<string[]>(seenKey(environment))) ?? []);
      // Re-read: the watch may have been changed or removed while the list was read; what it matches now decides.
      const current = await this.get(environment);
      if (!current || current.createdAt !== watch.createdAt) continue;
      const found = recent.filter((item) => !seen.has(item.ticker) && watchMatches(current, item))
        .sort((a, b) => Date.parse(b.addedOn!) - Date.parse(a.addedOn!) || a.ticker.localeCompare(b.ticker));
      await this.deps.store.put(seenKey(environment), recent.map((item) => item.ticker));
      await this.deps.store.put(watchKey(environment), {
        ...current, lastCheckedAt: now.toISOString(), ...(found.length ? { lastFoundAt: now.toISOString(), lastFound: found.length } : {}),
      });
      if (!found.length) {
        reports.push({ environment, action: "none", tickers: [], message: "Nothing new." });
        continue;
      }
      const outcome = listingOutcome(found);
      await this.deps.trading.recordActivity("new_listings", environment, {
        ...(found.length === 1 ? { ticker: found[0]!.ticker } : {}),
        outcome,
      });
      reports.push({ environment, action: "found", tickers: found.map((item) => item.ticker), message: outcome });
    }
    return reports;
  }
}
