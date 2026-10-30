// The account's history as TradePilot has read it, kept between reads. Trading 212 gives history newest first, 50
// records a page, a few pages a minute: a year of an active account is more pages than one read can wait for, and
// every read used to start again from the newest. Records in the history are final (a filled or cancelled order, a
// paid dividend, a settled cash movement), so what was read once is kept, per account and kind: a read asks only for
// the pages newer than what is kept, until it reaches a record it has, and then goes on further back from where the
// last read stopped. Each read adds to it, so an account's whole history is read once, over as many reads as it takes.
//
// Kept in the state store in chunks of CHUNK records (a Durable Object's value is at most 2 MB), numbered from the
// oldest, so the newest records, which change at every read, are in the last chunk or two.

import type { HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem } from "../shared/history.js";
import type { StateStore } from "./state-store.js";
import type { HistoryKind } from "./trading212-client.js";

type Item = HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem;

/** Records in a chunk; a few hundred bytes each. */
export const CHUNK = 400;
/** Records kept of one kind at most; past this the oldest go, and the history is no longer whole. */
export const MAX_RECORDS = 40_000;

export interface LedgerMeta {
  version: 1;
  /** Records kept. */
  count: number;
  /** Chunks the records are in. */
  chunks: number;
  /** Trading 212's path to the page after the oldest record kept; null when there is none. */
  next: string | null;
  /** The oldest record kept is the account's first: there is nothing further back. */
  complete: boolean;
  /** When the oldest record kept is from, where it says. */
  oldestAt?: string;
  updatedAt: string;
}

export interface Ledger<T extends Item = Item> {
  meta: LedgerMeta;
  /** Newest first. */
  items: T[];
  /** Each chunk as this load read it, so a save writes only the chunks that changed since. */
  stored?: Map<string, string>;
}

/** What a record is known by: Trading 212's own reference or id where it has one, all of it where it has not. */
export function recordKey(kind: HistoryKind, item: Item): string {
  if (kind === "orders") {
    const { order, fill } = item as HistoryOrderItem;
    const fillId = fill?.id;
    if (fillId !== undefined || order?.id !== undefined) return `o:${String(order?.id ?? "")}:f:${String(fillId ?? "")}:${fill?.filledAt ?? ""}`;
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

const chunkKey = (prefix: string, index: number) => `${prefix}c:${String(index).padStart(5, "0")}`;

export class HistoryLedgers {
  /** One read or save of a ledger at a time in this process: two at once would read the same pages twice. */
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
    return meta?.version === 1 ? meta : undefined;
  }

  async load<T extends Item>(prefix: string): Promise<Ledger<T> | undefined> {
    const meta = await this.store.get<LedgerMeta>(`${prefix}meta`);
    if (!meta || meta.version !== 1) return undefined;
    const chunks = (await this.store.list<T[]>(`${prefix}c:`)).sort((a, b) => a.key.localeCompare(b.key));
    // A chunk missing or one too many (a save cut short): start again rather than keep a history with a hole in it.
    if (chunks.length !== meta.chunks) return undefined;
    const oldestFirst: T[] = [];
    const stored = new Map<string, string>();
    for (const chunk of chunks) {
      stored.set(chunk.key, JSON.stringify(chunk.value));
      oldestFirst.push(...chunk.value);
    }
    if (oldestFirst.length !== meta.count) return undefined;
    return { meta, items: oldestFirst.reverse(), stored };
  }

  async save(prefix: string, ledger: Ledger): Promise<void> {
    const items = ledger.items.slice(0, MAX_RECORDS);
    const capped = items.length < ledger.items.length;
    const oldestFirst = [...items].reverse();
    const chunks = Math.ceil(oldestFirst.length / CHUNK);
    for (let index = 0; index < chunks; index += 1) {
      const key = chunkKey(prefix, index);
      const json = JSON.stringify(oldestFirst.slice(index * CHUNK, (index + 1) * CHUNK));
      if (ledger.stored?.get(key) === json) continue;
      await this.store.put(key, JSON.parse(json) as unknown);
    }
    const before = await this.store.list<unknown>(`${prefix}c:`);
    for (const { key } of before) {
      if (chunks === 0 || key > chunkKey(prefix, chunks - 1)) await this.store.delete(key);
    }
    const meta: LedgerMeta = {
      version: 1,
      count: items.length,
      chunks,
      // Capped: the oldest records went, so the page after them would leave a hole; it is read no further.
      next: capped ? null : ledger.meta.next,
      complete: capped ? false : ledger.meta.complete,
      ...(ledger.meta.oldestAt ? { oldestAt: ledger.meta.oldestAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(`${prefix}meta`, meta);
  }

  /** Forgets an account's ledger of one kind. */
  async clear(prefix: string): Promise<void> {
    for (const { key } of await this.store.list<unknown>(prefix)) await this.store.delete(key);
  }
}
