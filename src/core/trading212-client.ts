import type { AccountSummary, Instrument, OrderDraft, PendingOrder, Position, TradingEnvironment } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";
import type { Exchange, ExportReport, HistoryDividendItem, HistoryOrderItem, HistoryTransactionItem, Page } from "../shared/history.js";
import type { PieDetail, PieRequest, PieSummary } from "../shared/pies.js";
import { endpointOf, limitKey, recordLimit, waitFor, waitIfSent } from "./rate-limit.js";

export type HistoryKind = "orders" | "dividends" | "transactions";
type HistoryItem<K extends HistoryKind> = K extends "orders" ? HistoryOrderItem : K extends "dividends" ? HistoryDividendItem : HistoryTransactionItem;

export class Trading212ApiError extends Error {
  constructor(message: string, readonly status: number, readonly responseBody: unknown) { super(message); this.name = "Trading212ApiError"; }
}
export class ExecutionStatusUnknownError extends Error {
  constructor(message: string, readonly causeValue?: unknown) { super(message); this.name = "ExecutionStatusUnknownError"; }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const WRITE_RETRY_MIN_MS = 2100;
const WRITE_RETRY_MAX_MS = 15_000;
/** A read waits this long at most for its endpoint's limit to reset, as long as a 429's retry would. */
const READ_PACE_MAX_MS = 60_000;
function basic(value: string): string {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function unwrapArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") for (const key of ["items", "data", "orders", "positions", "instruments"])
    if (Array.isArray((value as Record<string, unknown>)[key])) return (value as Record<string, T[]>)[key]!;
  return [];
}
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text(); if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}
/** The positions endpoint names the instrument's currency `currency`; the rest of TradePilot reads `currencyCode`. */
function normalizePosition(position: Position): Position {
  const instrument = position.instrument as (Partial<Instrument> & { currency?: unknown }) | undefined;
  if (!instrument || instrument.currencyCode || typeof instrument.currency !== "string") return position;
  return { ...position, instrument: { ...instrument, currencyCode: instrument.currency } as Instrument };
}
/** `nextPagePath` may include the `/api/v0` prefix; the client's base URL already ends with it. */
export function relativeApiPath(pagePath: string): string {
  const path = pagePath.startsWith("http") ? new URL(pagePath).pathname + new URL(pagePath).search : pagePath;
  if (!path.startsWith("/")) throw new Error("Unexpected Trading 212 page path");
  return path.replace(/^\/api\/v0(?=\/)/, "");
}

export function retryDelayMs(response: Response, attempt: number, now = Date.now()): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter); if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000 + 100, 60_000);
    const date = Date.parse(retryAfter); if (Number.isFinite(date)) return Math.min(Math.max(0, date - now) + 100, 60_000);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(0, (reset > 1e10 ? reset : reset * 1000) - now) + 100, 60_000);
  return Math.min(300 * 2 ** Math.max(0, attempt - 1), 5000);
}

/** The fetch every client uses unless handed another: one function, so their reads can be shared (see `reads`). */
const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** A read on its way (since `started`), or the last answer of a read kept for a few seconds (from `at`). */
interface SharedRead { promise?: Promise<unknown>; started?: number; value?: unknown; at?: number }
/**
 * Reads shared by every client of one account in this process (the widget's, the model's tools', the scheduler's),
 * kept per fetch function so a test's fake never answers another's:
 * - a read already on its way is joined rather than sent again, so a dashboard and the day's change opened together
 *   read the account summary once (not on Cloudflare: see `shareReadsOnTheirWay`);
 * - when an endpoint's limit is used up (one account summary in five seconds), the answer it gave in the last few
 *   seconds is returned rather than waiting for the limit to reset. A read that must be current (the order book the
 *   protective links are settled from, the holdings and cash an order is sent against) asks `fresh` and never gets one.
 * An order or a cancel sent from this process forgets what is kept of its account, before it is sent and after it is
 * answered, so nothing read before it answers a read made after it here. Writes from elsewhere (another isolate,
 * Trading 212's app) are not seen: that is what `fresh` is for.
 */
const reads = new WeakMap<typeof fetch, Map<string, SharedRead>>();
/** How old a kept answer may be. Trading 212's tightest read limits are one in five seconds. */
export const SHARED_READ_MS = 5000;
/** The reads whose answer is kept: what the account holds and owes, read by nearly every view. */
const KEPT_READS = new Set(["/equity/account/summary", "/equity/positions", "/equity/orders"]);
/** No more kept reads than this per fetch function; the oldest go first. */
const MAX_SHARED_READS = 200;
/**
 * A read on its way longer than this is not joined: the longest a read can take (a minute's wait for its limit, four
 * attempts of 20 seconds and their backoff) and some. One that never settles cannot hold the reads after it.
 */
const PENDING_READ_MAX_MS = 180_000;
let joinPending = true;

/**
 * Whether a read on its way is joined by other callers. Cloudflare Workers cancels a request's fetch once that request
 * has answered, which would leave the readers that joined it waiting for good, so its adapter turns this off: there
 * only answers already given are shared, which are plain data.
 */
export function shareReadsOnTheirWay(on: boolean): void { joinPending = on; }
/** Whether a caller may join a read another caller started (see `shareReadsOnTheirWay`). */
export function readsOnTheirWayShared(): boolean { return joinPending; }

/** For tests: forget every shared read. */
export function resetSharedReads(): void { reads.delete(globalFetch); }

export class Trading212Client {
  private readonly target;
  private readonly fetcher: typeof fetch;
  /** The account the limits are counted for: one key's requests share them, whichever client sends them. */
  private readonly account: string;
  constructor(readonly environment: TradingEnvironment, config: RuntimeConfig, fetcher?: typeof fetch) {
    this.target = config.trading212[environment];
    this.fetcher = fetcher ?? globalFetch;
    if (!this.target.apiKey || !this.target.apiSecret) throw new Error(`Trading 212 ${environment.toUpperCase()} API credentials are not configured`);
    this.account = `${environment} ${this.target.baseUrl} ${this.target.apiKey}`;
  }
  /**
   * Waits for the endpoint's limit when the last response left nothing of it, or refuses the request unsent when the
   * reset is further off than a caller should wait: a write is not sent, so its status is known.
   */
  private async pace(method: "GET" | "POST" | "DELETE", path: string, key: string): Promise<void> {
    const most = Date.now() + (method === "GET" ? READ_PACE_MAX_MS : WRITE_RETRY_MAX_MS);
    // Asked again after each wait: another caller's response may have said what the new window has meanwhile.
    for (let wait = waitFor(key); wait > 0; wait = waitFor(key)) {
      if (Date.now() + wait > most) {
        throw new Trading212ApiError(`Trading 212's limit for ${endpointOf(method, path)} is used up until ${new Date(Date.now() + wait).toISOString()}; the request was not sent. Try again after that.`, 429, null);
      }
      await sleep(wait + 100);
    }
  }
  private shared(): Map<string, SharedRead> {
    let shared = reads.get(this.fetcher);
    if (!shared) { shared = new Map(); reads.set(this.fetcher, shared); }
    return shared;
  }
  /** Forget this account's kept and pending reads: what a write may have changed is read again. */
  private forgetReads(): void {
    const shared = this.shared();
    for (const key of [...shared.keys()]) if (key.startsWith(`${this.account} `)) shared.delete(key);
  }
  /** `fresh`: read Trading 212 now, neither joining a read on its way nor taking a kept answer. */
  private request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, fresh = false): Promise<T> {
    if (method !== "GET") {
      this.forgetReads();
      return this.send<T>(method, path, body).finally(() => this.forgetReads());
    }
    const shared = this.shared();
    const key = `${this.account} ${path}`;
    const kept = shared.get(key);
    const now = Date.now();
    if (!fresh && kept?.promise && joinPending && now - kept.started! < PENDING_READ_MAX_MS) return kept.promise as Promise<T>;
    if (!fresh && kept?.at !== undefined && now - kept.at < SHARED_READ_MS && waitIfSent(limitKey(this.account, "GET", path)) > 0) return Promise.resolve(kept.value as T);
    const promise: Promise<T> = this.send<T>("GET", path).then(
      (value) => {
        if (shared.get(key)?.promise !== promise) return value;
        if (KEPT_READS.has(path)) {
          shared.delete(key);
          shared.set(key, { value, at: Date.now() });
          if (shared.size > MAX_SHARED_READS) shared.delete(shared.keys().next().value!);
        } else shared.delete(key);
        return value;
      },
      (error: unknown) => {
        const entry = shared.get(key);
        if (entry?.promise === promise) {
          if (entry.at === undefined) shared.delete(key);
          else shared.set(key, { value: entry.value, at: entry.at });
        }
        throw error;
      },
    );
    // A kept answer stays while the new read is on its way, for a reader that finds the limit used up meanwhile.
    shared.delete(key);
    shared.set(key, { promise, started: now, ...(kept?.at !== undefined ? { value: kept.value, at: kept.at } : {}) });
    return promise;
  }
  private async send<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    // A rate-limited write was refused before it was processed, so it is the one write sent again.
    const attempts = method === "GET" ? 4 : 2;
    const key = limitKey(this.account, method, path);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.pace(method, path, key);
      let response: Response;
      try {
        response = await this.fetcher(`${this.target.baseUrl}${path}`, { method, headers: {
          Authorization: `Basic ${basic(`${this.target.apiKey}:${this.target.apiSecret}`)}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        // Never followed: a redirect would carry the keys elsewhere, and turns a write into a GET without its body.
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(20_000) });
      } catch (error) {
        if (method !== "GET") throw new ExecutionStatusUnknownError("Trading 212 did not return a response. The order/cancel status is unknown; verify the order list before trying again.", error);
        if (attempt === attempts) throw error; await sleep(Math.min(300 * 2 ** (attempt - 1), 5000)); continue;
      }
      recordLimit(key, response.headers);
      // A redirect (an opaque one where the runtime hides it) is not Trading 212's answer: a write's outcome is unknown.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        if (method !== "GET") throw new ExecutionStatusUnknownError(`Trading 212's address answered a write with a redirect (${response.status}), which is not followed. The order/cancel status is unknown; verify the order list, and check T212_${this.environment.toUpperCase()}_BASE_URL.`, null);
        throw new Trading212ApiError(`Trading 212 ${method} ${path} was redirected (${response.status}), which is not followed; check the API address (T212_${this.environment.toUpperCase()}_BASE_URL).`, response.status, null);
      }
      let parsed: unknown;
      try {
        parsed = await readBody(response);
      } catch (error) {
        // A write the broker accepted (or may have accepted) must never be reported as rejected.
        if (method !== "GET" && (response.ok || response.status === 408 || response.status >= 500))
          throw new ExecutionStatusUnknownError(`Trading 212 returned ${response.status} but the response could not be read. The order/cancel status is unknown; verify the order list before trying again.`, error);
        if (method === "GET" && attempt < attempts) { await sleep(retryDelayMs(response, attempt)); continue; }
        throw new Trading212ApiError(`Trading 212 ${method} ${path} failed (${response.status}) and the response could not be read`, response.status, null);
      }
      if (response.ok) return parsed as T;
      if (method !== "GET" && (response.status === 408 || response.status >= 500))
        throw new ExecutionStatusUnknownError(`Trading 212 returned ${response.status} after a write. Execution status is unknown; refresh orders before trying again.`, parsed);
      if (method === "GET" && (response.status === 408 || response.status === 429 || response.status >= 500) && attempt < attempts) {
        await sleep(retryDelayMs(response, attempt)); continue;
      }
      if (method !== "GET" && response.status === 429 && attempt < attempts) {
        const wait = retryDelayMs(response, attempt);
        // Limit, Stop and Stop-Limit orders allow one request per 2 seconds; a longer wait is reported instead.
        if (wait <= WRITE_RETRY_MAX_MS) { await sleep(Math.max(wait, WRITE_RETRY_MIN_MS)); continue; }
      }
      const detail = parsed == null || parsed === "" ? "" : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Trading212ApiError(`Trading 212 ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`, response.status, parsed);
    }
    throw new Error("Unreachable Trading 212 request state");
  }
  // A read's answer may be shared with other callers (see `reads`), so each gets its own copy of the outer object.
  // `fresh` reads Trading 212 now rather than an answer of the last seconds (see `reads`).
  async getAccountSummary(options: { fresh?: boolean } = {}) { return { ...await this.request<AccountSummary>("GET", "/equity/account/summary", undefined, options.fresh) }; }
  async getPositions(options: { fresh?: boolean } = {}) { return unwrapArray<Position>(await this.request("GET", "/equity/positions", undefined, options.fresh)).map(normalizePosition); }
  async getOrders(options: { fresh?: boolean } = {}) { return [...unwrapArray<PendingOrder>(await this.request("GET", "/equity/orders", undefined, options.fresh))]; }
  getOrder(id: string) { return this.request<PendingOrder>("GET", `/equity/orders/${encodeURIComponent(id)}`); }
  async getInstruments() { return unwrapArray<Instrument>(await this.request("GET", "/equity/metadata/instruments")); }
  placeOrder(draft: OrderDraft): Promise<unknown> {
    const quantity = draft.side === "buy" ? draft.quantity : -draft.quantity;
    if (draft.type === "market") return this.request("POST", "/equity/orders/market", { ticker: draft.ticker, quantity, ...(draft.extendedHours === undefined ? {} : { extendedHours: draft.extendedHours }) });
    const timeValidity = draft.timeValidity ?? "DAY";
    if (draft.type === "limit") return this.request("POST", "/equity/orders/limit", { ticker: draft.ticker, quantity, limitPrice: draft.limitPrice, timeValidity });
    if (draft.type === "stop") return this.request("POST", "/equity/orders/stop", { ticker: draft.ticker, quantity, stopPrice: draft.stopPrice, timeValidity });
    return this.request("POST", "/equity/orders/stop_limit", { ticker: draft.ticker, quantity, limitPrice: draft.limitPrice, stopPrice: draft.stopPrice, timeValidity });
  }
  cancelOrder(id: string) { return this.request<unknown>("DELETE", `/equity/orders/${encodeURIComponent(id)}`); }

  async getExchanges() { return unwrapArray<Exchange>(await this.request("GET", "/equity/metadata/exchanges")); }

  /** One page of history. `pagePath` is the broker's `nextPagePath` from the previous page. */
  /** `ticker` narrows orders and dividends on the broker side; later pages keep it through nextPagePath. */
  async getHistoryPage<K extends HistoryKind>(kind: K, pagePath?: string, ticker?: string): Promise<Page<HistoryItem<K>>> {
    const filter = ticker && kind !== "transactions" ? `&ticker=${encodeURIComponent(ticker)}` : "";
    const path = pagePath ? relativeApiPath(pagePath) : `/equity/history/${kind}?limit=50${filter}`;
    const page = await this.request<Page<HistoryItem<K>> | HistoryItem<K>[]>("GET", path);
    return Array.isArray(page) ? { items: page, nextPagePath: null } : { items: page?.items ?? [], nextPagePath: page?.nextPagePath ?? null };
  }

  listExports() { return this.request<ExportReport[]>("GET", "/equity/history/exports"); }
  requestExport(body: { timeFrom: string; timeTo: string; dataIncluded: { includeDividends: boolean; includeInterest: boolean; includeOrders: boolean; includeTransactions: boolean } }) {
    return this.request<{ reportId: number }>("POST", "/equity/history/exports", body);
  }

  // Pies. Trading 212 marks these endpoints deprecated but still serves them; they need the pies scopes.
  async getPies() { return unwrapArray<PieSummary>(await this.request("GET", "/equity/pies")); }
  getPie(id: number) { return this.request<PieDetail>("GET", `/equity/pies/${id}`); }
  createPie(body: PieRequest) { return this.request<PieDetail>("POST", "/equity/pies", body); }
  updatePie(id: number, body: PieRequest) { return this.request<PieDetail>("POST", `/equity/pies/${id}`, body); }
  deletePie(id: number) { return this.request<unknown>("DELETE", `/equity/pies/${id}`); }
  duplicatePie(id: number, body: { name?: string; icon?: string }) { return this.request<PieDetail>("POST", `/equity/pies/${id}/duplicate`, body); }
}
