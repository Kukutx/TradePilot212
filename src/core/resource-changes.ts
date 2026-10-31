// What changed in the account's resources (tradepilot://<environment>/<name>), for a client that subscribed to one.
// The saved state is watched where it is written, the store, so a change made from the widget, a tool, the scheduler
// or another TradePilot tool reaches the subscriber the same way. The holdings come from Trading 212: they are said to
// change after TradePilot sends something there and after the scheduler records the account value each hour.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { StateStore } from "./state-store.js";

export type ResourceName = "holdings" | "journal" | "targets" | "goal" | "watchlist";
const ENVIRONMENTS: TradingEnvironment[] = ["demo", "live"];

export const resourceUri = (environment: TradingEnvironment, name: ResourceName) => `tradepilot://${environment}/${name}`;

export class ResourceChanges {
  private readonly listeners = new Set<(uri: string) => void>();

  /** Call `listener` with each changed resource's address; the returned function stops it. */
  on(listener: (uri: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(environment: TradingEnvironment, name: ResourceName): void {
    const uri = resourceUri(environment, name);
    for (const listener of this.listeners) {
      try {
        listener(uri);
      } catch {
        // A subscriber that fails never stops a write.
      }
    }
  }
}

const environmentOf = (text: string | undefined): TradingEnvironment | undefined => (text === "demo" || text === "live" ? text : undefined);

/**
 * The resources a write to `key` changes. A journal note's key carries no account, so its value names it; a removed
 * one, whose value is gone, counts for both accounts.
 */
export function resourcesOfKey(key: string, value?: unknown): Array<[TradingEnvironment, ResourceName]> {
  const [prefix, second] = key.split(":");
  if (prefix === "goal" || prefix === "goal-milestone") { const environment = environmentOf(second); return environment ? [[environment, "goal"]] : []; }
  if (prefix === "targets") { const environment = environmentOf(second); return environment ? [[environment, "targets"]] : []; }
  if (prefix === "watch") { const environment = environmentOf(second); return environment ? [[environment, "watchlist"]] : []; }
  if (prefix === "journal") {
    const environment = environmentOf((value as { environment?: string } | undefined)?.environment);
    return environment ? [[environment, "journal"]] : ENVIRONMENTS.map((item) => [item, "journal"]);
  }
  return [];
}

/** The store, saying what each write changed once it is written. Reads pass straight through. */
export function watchingStore(store: StateStore, changes: ResourceChanges): StateStore {
  const said = (key: string, value?: unknown) => { for (const [environment, name] of resourcesOfKey(key, value)) changes.emit(environment, name); };
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "put") return async (key: string, value: unknown, expiresAt?: number) => { await target.put(key, value, expiresAt); said(key, value); };
      if (property === "delete") return async (key: string) => { await target.delete(key); said(key); };
      if (property === "consume") return async (key: string) => { const value = await target.consume(key); if (value !== undefined) said(key, value); return value; };
      const member = Reflect.get(target, property, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
