// The trade journal: a note per trade with why it was made and, later, what came of it. An order sent with a
// thesis saves one by itself, with the order id Trading 212 gave it; notes can also be added to past fills
// or to an instrument without an order. Notes are TradePilot's own; nothing here reaches Trading 212.

import type { OrderDraft, TradingEnvironment } from "../shared/contracts.js";
import { journalTags, journalText, type JournalEntry } from "../shared/journal.js";
import { requireCredentials, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import { randomToken } from "./web-utils.js";

export const MAX_JOURNAL_ENTRIES = 1000;
const entryKey = (id: string) => `journal:${id}`;

export interface JournalInput {
  environment: TradingEnvironment;
  instrument: string;
  orderId?: string;
  thesis?: string;
  review?: string;
  tags?: string[];
}

/** A field left out stays as it is; an empty string or list clears it. */
export interface JournalChange {
  thesis?: string;
  review?: string;
  tags?: string[];
}

function orderIdOf(value: string | undefined): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (!/^\d{1,20}$/.test(id)) fail("INVALID_INPUT", "orderId must be the numeric Trading 212 order id.", { field: "orderId" });
  return id;
}

/** The id Trading 212 gave an order it accepted, from its reply. */
function acceptedOrderId(order: unknown): string | undefined {
  const id = order && typeof order === "object" ? (order as { id?: unknown }).id : undefined;
  return (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && /^\d{1,20}$/.test(id)) ? String(id) : undefined;
}

const newestFirst = (a: JournalEntry, b: JournalEntry) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export class TradeJournal {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: Pick<TradingService, "instruments"> }) {}

  /** Newest first. `ticker` is an exact Trading 212 ticker; `orderIds` keeps only notes on those orders. */
  async list(environment?: TradingEnvironment, filter: { ticker?: string; orderIds?: Iterable<string> } = {}): Promise<JournalEntry[]> {
    const ticker = filter.ticker?.trim().toUpperCase();
    const orders = filter.orderIds ? new Set(filter.orderIds) : undefined;
    return (await this.deps.store.list<JournalEntry>("journal:"))
      .map((entry) => entry.value)
      .filter((entry) => (!environment || entry.environment === environment)
        && (!ticker || entry.ticker.toUpperCase() === ticker)
        && (!orders || (entry.orderId !== undefined && orders.has(entry.orderId))))
      .sort(newestFirst);
  }

  async add(input: JournalInput, now = new Date()): Promise<JournalEntry> {
    requireCredentials(this.deps.config, input.environment);
    const thesis = journalText(input.thesis);
    const review = journalText(input.review);
    if (!thesis && !review) fail("INVALID_INPUT", "A journal note needs a thesis or a review", { field: "thesis" });
    const orderId = orderIdOf(input.orderId);
    const instrument = resolveInstrumentFromList(await this.deps.trading.instruments(input.environment), input.instrument);
    const all = await this.list();
    if (all.length >= MAX_JOURNAL_ENTRIES) fail("INVALID_INPUT", `At most ${MAX_JOURNAL_ENTRIES} journal notes can be stored; delete old ones first`);
    // One note per order, so a fill shows one reason; a second one changes the first.
    const existing = orderId ? all.find((entry) => entry.environment === input.environment && entry.orderId === orderId) : undefined;
    if (existing) fail("INVALID_INPUT", `Order ${orderId} already has journal note ${existing.id}; update that note instead`, { field: "orderId", entryId: existing.id });
    const tags = journalTags(input.tags);
    const entry: JournalEntry = {
      id: `jrn_${randomToken(12)}`,
      environment: input.environment,
      ticker: instrument.ticker,
      ...(orderId ? { orderId } : {}),
      ...(thesis ? { thesis } : {}),
      ...(review ? { review } : {}),
      ...(tags ? { tags } : {}),
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(entryKey(entry.id), entry);
    return entry;
  }

  private async get(id: string): Promise<JournalEntry> {
    const entry = await this.deps.store.get<JournalEntry>(entryKey(id));
    if (!entry) fail("JOURNAL_ENTRY_NOT_FOUND", "Journal note not found", { entryId: id });
    return entry;
  }

  async update(id: string, change: JournalChange, now = new Date()): Promise<JournalEntry> {
    const current = await this.get(id);
    const thesis = change.thesis === undefined ? current.thesis : journalText(change.thesis);
    const review = change.review === undefined ? current.review : journalText(change.review);
    const tags = change.tags === undefined ? current.tags : journalTags(change.tags);
    if (!thesis && !review) fail("INVALID_INPUT", "A journal note needs a thesis or a review; delete it instead", { field: "thesis" });
    const { thesis: _t, review: _r, tags: _g, ...rest } = current;
    const entry: JournalEntry = { ...rest, ...(thesis ? { thesis } : {}), ...(review ? { review } : {}), ...(tags ? { tags } : {}), updatedAt: now.toISOString() };
    await this.deps.store.put(entryKey(id), entry);
    return entry;
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.deps.store.delete(entryKey(id));
  }

  /**
   * Save the thesis an order was sent with, once Trading 212 accepted it (with its order id) or its result was
   * unclear. Returns the note's id, or nothing when the order had no thesis or the journal is full.
   */
  async recordOrder(draft: OrderDraft, outcome: { order?: unknown; unconfirmed?: boolean }, now = new Date()): Promise<string | undefined> {
    const thesis = journalText(draft.thesis);
    if (!thesis) return undefined;
    const all = await this.list();
    if (all.length >= MAX_JOURNAL_ENTRIES) return undefined;
    const orderId = outcome.unconfirmed ? undefined : acceptedOrderId(outcome.order);
    const entry: JournalEntry = {
      id: `jrn_${randomToken(12)}`,
      environment: draft.environment,
      ticker: draft.ticker,
      ...(orderId ? { orderId } : {}),
      order: { side: draft.side, type: draft.type, quantity: draft.quantity, ...(outcome.unconfirmed ? { unconfirmed: true as const } : {}) },
      thesis,
      createdAt: now.toISOString(),
    };
    await this.deps.store.put(entryKey(entry.id), entry);
    return entry.id;
  }
}
