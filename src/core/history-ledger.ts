// The account's history as TradePilot has read it, kept between reads. Trading 212 gives history newest first, 50
// records a page, a few pages a minute: years of an active account are more pages than one read can wait for, and
// every read used to start again from the newest. Records in the history are final (a filled or cancelled order, a
// paid dividend, a settled cash movement), so what was read once is kept, per account and kind, and each read goes
// on from where the last one stopped. An account's history is read once, over as many reads as it takes.
//
// What is known of it is kept as segments: runs of the history read without a gap, each from the newest record when
// its read began down to its `bottom`, with Trading 212's path to the page below. A read begins a segment at the
// newest record and reads down until it joins the segment below (past the records that could have come in above that
// one since it was read), so a read that runs out of pages leaves a segment of its own rather than a hole, and the
// next read goes on from it. Orders open at a read are not in the history yet, and Trading 212 places an order by
// when it was made, so one made weeks ago that fills later lands among old records: their ids are kept as pending,
// and once one is no longer open it is looked for in its instrument's history.
//
// The records are kept as a set: each read adds the ones it found new as chunks of their own, and loading takes the
// union of the chunks by each record's key. Nothing is rewritten in place, so two processes adding at once (a
// scheduled run and a request, two local hosts on one state file) cannot lose each other's records; at worst a record
// is in two chunks and is counted once. Once there are many chunks they are merged, the merged ones deleted after.

import type { HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem } from "../shared/history.js";
import type { StateStore } from "./state-store.js";
import type { HistoryKind } from "./trading212-client.js";

export type LedgerItem = HistoryOrderItem | HistoryDividendItem | HistoryTransactionItem;

/** Records kept of one kind at most (a few MB); past this the oldest go, down to TRIM_TO, and with them the way back. */
export const MAX_RECORDS = 10_000;
const TRIM_TO = 9_000;
/** Past this many chunks, the next read merges them. */
export const MAX_CHUNKS = 24;
/** A chunk is kept under this much JSON: a Durable Object holds 2 MB in one value at most. */
const CHUNK_CHARS = 1_000_000;
/** Segments kept at most; past this the oldest are forgotten (their records stay). */
const MAX_SEGMENTS = 8;
/**
 * Records placed this long before a read may still come into the history after it (a movement settled late, an
 * order made just before the read and filled just after), so a later read goes this far below a segment's start
 * before it joins it.
 */
export const SETTLE_MS = 3 * 86_400_000;

export interface LedgerSegment {
  /** When the read that began it started: it holds every record placed in the history before then, down to `bottom`. */
  readAt: string;
  /** Where the lowest record read in it is placed; none while it has read none. */
  bottom?: string;
  /** Trading 212's path to the page below `bottom`; null when there is none to read. */
  next: string | null;
  /** It reaches the account's first record. */
  complete: boolean;
}

/** An order open at a read: it comes into the history, at when it was made, once it fills or is cancelled. */
export interface LedgerPending {
  id: string;
  ticker: string;
  createdAt: string;
  /** Its records kept when it was last open: one partly filled may have a fill listed already. */
  seen?: number;
  /** When it was first looked for and not found, no longer open: Trading 212 may list it a little later. */
  missingSince?: string;
}

export interface LedgerMeta {
  version: 3;
  /** Newest first. */
  segments: LedgerSegment[];
  pending: LedgerPending[];
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

/** Times of records: `time` orders them (a fill by when it filled), `place` is where the history places them. */
export interface LedgerTimes<T extends LedgerItem> {
  time: (item: T) => number;
  place: (item: T) => number;
}

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
    return meta?.version === 3 && Array.isArray(meta.segments) ? meta : undefined;
  }

  /** The records kept, each once, newest first by `time` (those without one last), and what is known of them. */
  async load<T extends LedgerItem>(prefix: string, kind: HistoryKind, times: LedgerTimes<T>): Promise<Ledger<T> | undefined> {
    const meta = await this.meta(prefix);
    const chunks = await this.store.list<T[]>(`${prefix}c:`);
    if (!meta && !chunks.length) return undefined;
    const items = union(kind, chunks.flatMap((chunk) => chunk.value), times.time);
    const known = meta ?? { version: 3 as const, segments: [], pending: [], updatedAt: new Date(0).toISOString() };
    return { meta: { ...known, segments: within(known.segments, items, times.place, await this.floor(prefix)) }, items, chunks: chunks.map((chunk) => chunk.key) };
  }

  /** Below this place, records went past MAX_RECORDS. */
  private async floor(prefix: string): Promise<number | undefined> {
    const floor = await this.store.get<number>(`${prefix}floor`);
    return typeof floor === "number" && Number.isFinite(floor) ? floor : undefined;
  }

  /**
   * Adds `added` to what `ledger` was loaded with, and sets what is known of it. Past MAX_CHUNKS the chunks loaded
   * are merged (written before they are deleted); past MAX_RECORDS the oldest go, and the segments that reached them
   * stop there. Returns the records now kept and what is known of them.
   */
  async add<T extends LedgerItem>(prefix: string, kind: HistoryKind, ledger: Ledger<T> | undefined, added: T[],
    meta: Pick<LedgerMeta, "segments" | "pending">, times: LedgerTimes<T>): Promise<{ items: T[]; meta: LedgerMeta }> {
    let items = union(kind, [...added, ...(ledger?.items ?? [])], times.time);
    const capped = items.length > MAX_RECORDS;
    let floor = await this.floor(prefix);
    if (capped) {
      // The lowest placed go, so every record placed above the lowest kept is still kept and the segments can stop
      // there; one placed lower but in the history later (an old order filled since) stays too.
      const placed = items.map(times.place).filter(Number.isFinite).sort((a, b) => b - a);
      const cut = placed[Math.min(TRIM_TO, placed.length) - 1];
      if (cut !== undefined) {
        items = items.filter((item) => !(times.place(item) < cut) || !(times.time(item) < cut));
        floor = Math.max(floor ?? cut, cut);
        // Kept apart from the meta, which another process may write from what it loaded before this.
        await this.store.put(`${prefix}floor`, floor);
      }
    }
    const chunks = ledger?.chunks ?? [];
    const still = new Set(items);
    const fresh = added.filter((item) => still.has(item));
    if (capped || chunks.length + split(fresh).length > MAX_CHUNKS) {
      for (const chunk of split(items)) await this.store.put(chunkKey(prefix), chunk);
      for (const key of chunks) await this.store.delete(key);
    } else {
      for (const chunk of split(fresh)) await this.store.put(chunkKey(prefix), chunk);
    }
    const kept: LedgerMeta = {
      version: 3,
      segments: fewest(within(meta.segments, items, times.place, floor)),
      pending: meta.pending,
      updatedAt: new Date().toISOString(),
    };
    await this.store.put<LedgerMeta>(`${prefix}meta`, kept);
    return { items, meta: kept };
  }
}

/**
 * The segments as far as the records kept bear them out. A segment reaches down to the lowest record read in it, so
 * one whose bottom is below every record kept lost its lowest ones (the oldest went past MAX_RECORDS, here or in
 * another process): it stops at the lowest kept, with no way further back.
 */
function within<T extends LedgerItem>(segments: LedgerSegment[], items: T[], place: (item: T) => number, trimmed?: number): LedgerSegment[] {
  const placed = items.map(place).filter(Number.isFinite);
  const lowest = placed.length ? Math.min(...placed) : undefined;
  const floor = trimmed === undefined ? lowest : Math.max(trimmed, lowest ?? trimmed);
  return segments.flatMap((segment) => {
    if (segment.bottom === undefined || floor === undefined || Date.parse(segment.bottom) >= floor) return [segment];
    if (Date.parse(segment.readAt) < floor) return [];
    return [{ readAt: segment.readAt, bottom: new Date(floor).toISOString(), next: null, complete: false }];
  });
}

/**
 * At most MAX_SEGMENTS: the newest, which this read is on, and the oldest, which hold the most; the ones between
 * (runs a busy account left without joining up) go first. Their records stay.
 */
function fewest(segments: LedgerSegment[]): LedgerSegment[] {
  return segments.length <= MAX_SEGMENTS ? segments : [segments[0]!, ...segments.slice(segments.length - MAX_SEGMENTS + 1)];
}

/** Records in chunks of at most CHUNK_CHARS of JSON each. */
function split<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let size = 0;
  for (const item of items) {
    const length = JSON.stringify(item).length + 1;
    if (chunk.length && size + length > CHUNK_CHARS) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(item);
    size += length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** Each record once (the first seen of a key), newest first by `time`, those without one last in the order seen. */
export function union<T extends LedgerItem>(kind: HistoryKind, items: T[], time: (item: T) => number): T[] {
  const seen = new Set<string>();
  const once = items.filter((item) => { const key = recordKey(kind, item); if (seen.has(key)) return false; seen.add(key); return true; });
  const at = (item: T) => { const value = time(item); return Number.isFinite(value) ? value : -Infinity; };
  return once.map((item, index) => ({ item, index })).sort((a, b) => at(b.item) - at(a.item) || a.index - b.index).map(({ item }) => item);
}
