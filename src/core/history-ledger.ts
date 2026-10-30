// The account's history as TradePilot has read it, kept between reads. Trading 212 gives history newest first, 50
// records a page, a few pages a minute: years of an active account are more pages than one read can wait for, and
// every read used to start again from the newest. Records in the history are final (a filled or cancelled order, a
// paid dividend, a settled cash movement), so what was read once is kept, per account and kind, and a read asks for
// the newest pages, down to the records that could still have changed since the last read, and then goes on further
// back from where the last read stopped. Each read adds to it, so an account's history is read once, over as many
// reads as it takes.
//
// Kept as a set: each read adds the records it found new as a chunk of its own, and loading takes the union of the
// chunks by each record's key. Nothing is ever rewritten in place, so two processes adding at once (a scheduled run
// and a request, two local hosts on one state file) cannot lose each other's records; at worst a record is in two
// chunks and is counted once. Once there are many chunks they are merged into one, the merged ones deleted after.

import type { HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem } from "../shared/history.js";
import type { StateStore } from "./state-store.js";
import type { HistoryKind } from "./trading212-client.js";

export type LedgerItem = HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem;

/** Records kept of one kind at most (a few MB); past this the oldest go, and the history is no longer whole. */
export const MAX_RECORDS = 10_000;
/** Past this many chunks, the next read merges them into one. */
export const MAX_CHUNKS = 24;

export interface LedgerMeta {
  version: 2;
  /** Trading 212's path to the page after the oldest record read going back; null when there is none to read. */
  next: string | null;
  /** The account's first record is kept: there is nothing further back. */
  complete: boolean;
  /**
   * Records from before this were final at the last read: none can come into the history above them later. A read
   * goes down to it before it trusts the rest of what is kept.
   */
  horizon?: string;
  /** When the oldest record kept is from. */
  oldestAt?: string;
  updatedAt: string;
}

export interface Ledger<T extends LedgerItem = LedgerItem> {
  meta: LedgerMeta;
  /** Newest first. */
  items: T[];
  /** The chunks they were read from. */
  chunks: string[];
}

/** What a record is known by: Trading 212's own reference or ids where it has them, all of it where it has not. */
export function recordKey(kind: HistoryKind, item: LedgerItem): string {
  if (kind === "orders") {
    const { order, fill } = item as HistoryOrderItem;
    if (fill?.id !== undefined || order?.id !== undefined) return `o:${String(order?.id ?? "")}:f:${String(fill?.id ?? "")}:${fill?.filledAt ?? ""}`;
  } else {
    const reference = (item as HistoryDividendItem | HistoryTransactionItem).reference;
    if (reference) return `r:${reference}`;
  }
  return `j:${JSON.stringify(item)}`;
}

/** Where an account's ledger of one kind is kept. `account` names the API key without being it. */
export const ledgerPrefix = (environment: string, account: string, kind: HistoryKind) => `ledger:${environment}:${account}:${kind}:`;

/** A short, one-way name for an API key, so the store's keys never hold the key itself. */
export async function accountName(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tradepilot-ledger:${apiKey}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const chunkKey = (prefix: string) => `${prefix}c:${Date.now().toString(36).padStart(9, "0")}-${crypto.randomUUID().slice(0, 8)}`;

export class HistoryLedgers {
  /** One read of a ledger at a time in this process: two at once would read the same pages twice. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: StateStore) {}

  /** Runs `work` after any other work on this ledger in this process. */
  exclusive<T>(prefix: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(prefix) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    this.queues.set(prefix, settled);
    void settled.then(() => { if (this.queues.get(prefix) === settled) this.queues.delete(prefix); });
    return run;
  }

  /** What is kept, without the records. */
  async meta(prefix: string): Promise<LedgerMeta | undefined> {
    const meta = await this.store.get<LedgerMeta>(`${prefix}meta`);
    return meta?.version === 2 ? meta : undefined;
  }

  /** The records kept, each once, newest first by `time` (those without one last). */
  async load<T extends LedgerItem>(prefix: string, kind: HistoryKind, time: (item: T) => number): Promise<Ledger<T> | undefined> {
    const meta = await this.meta(prefix);
    if (!meta) return undefined;
    const chunks = await this.store.list<T[]>(`${prefix}c:`);
    return { meta, items: union(kind, chunks.flatMap((chunk) => chunk.value), time), chunks: chunks.map((chunk) => chunk.key) };
  }

  /**
   * Adds `added` to what `ledger` was loaded with, and sets the meta. Past MAX_CHUNKS the chunks loaded are merged
   * into one (written before they are deleted); past MAX_RECORDS the oldest go, and with them the way further back.
   * Returns the records now kept.
   */
  async add<T extends LedgerItem>(prefix: string, kind: HistoryKind, ledger: Ledger<T> | undefined, added: T[],
    meta: Pick<LedgerMeta, "next" | "complete" | "horizon">, time: (item: T) => number): Promise<T[]> {
    const all = union(kind, [...added, ...(ledger?.items ?? [])], time);
    const capped = all.length > MAX_RECORDS;
    const kept = capped ? all.slice(0, MAX_RECORDS) : all;
    const chunks = ledger?.chunks ?? [];
    if (capped || chunks.length + 1 > MAX_CHUNKS) {
      if (kept.length) await this.store.put(chunkKey(prefix), kept);
      for (const key of chunks) await this.store.delete(key);
    } else if (added.length) {
      await this.store.put(chunkKey(prefix), added);
    }
    const oldest = kept.map(time).filter(Number.isFinite).at(-1);
    await this.store.put<LedgerMeta>(`${prefix}meta`, {
      version: 2,
      // Capped: the oldest records went, so the page after them would leave a hole; it is read no further.
      next: capped ? null : meta.next,
      complete: capped ? false : meta.complete,
      ...(meta.horizon ? { horizon: meta.horizon } : {}),
      ...(oldest !== undefined ? { oldestAt: new Date(oldest).toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    });
    return kept;
  }

  /** Forgets an account's ledger of one kind. */
  async clear(prefix: string): Promise<void> {
    for (const { key } of await this.store.list<unknown>(prefix)) await this.store.delete(key);
  }
}

/** Each record once (the first seen of a key), newest first by `time`, those without one last in the order seen. */
function union<T extends LedgerItem>(kind: HistoryKind, items: T[], time: (item: T) => number): T[] {
  const seen = new Set<string>();
  const once = items.filter((item) => { const key = recordKey(kind, item); if (seen.has(key)) return false; seen.add(key); return true; });
  const at = (item: T) => { const value = time(item); return Number.isFinite(value) ? value : -Infinity; };
  return once.map((item, index) => ({ item, index })).sort((a, b) => at(b.item) - at(a.item) || a.index - b.index).map(({ item }) => item);
}
