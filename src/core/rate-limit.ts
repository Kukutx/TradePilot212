// Trading 212's limits are per account and per endpoint (six history reads a minute, one account summary in five
// seconds, …), and every response says where its endpoint stands: `x-ratelimit-remaining` requests left until
// `x-ratelimit-reset` (Unix seconds). One account's requests come from the widget, the model's tools, the
// scheduled runs and background reads at once, each through its own client, so what the responses say is kept here,
// per account and endpoint, for all of them: a request to an endpoint with nothing left waits for its reset, or is
// refused before it is sent when that is too far off, rather than spending a 429 that every caller then backs off from.
// Kept in memory, per process (per isolate on Workers): a best effort that a 429 still backs up.

/** Where an endpoint stood at its last response, less the requests sent since. */
interface Window {
  remaining: number;
  /** When the limit resets, ms since the epoch. */
  reset: number;
}

const windows = new Map<string, Window>();
/** No more endpoints than this are remembered; the oldest go first. */
const MAX_WINDOWS = 500;
/**
 * Trading 212's windows are a minute at most: a reset further off than this is taken as this, so a header out of
 * range (or a clock far behind) cannot hold an endpoint back for long.
 */
const MAX_RESET_MS = 5 * 60_000;
/**
 * When a used-up window resets, one request goes first and the rest wait this long for its response to say what the
 * new window has, rather than all going at once and most getting a 429.
 */
export const PROBE_MS = 2000;

/**
 * The limit an endpoint is counted under: the method and path without its query and with ids as `{id}`, so the
 * pages of one history and the orders by id share one.
 */
export function endpointOf(method: string, path: string): string {
  const bare = path.split("?")[0]!.replace(/\/(\d+|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?=\/|$)/g, "/{id}");
  return `${method} ${bare}`;
}

/** The account and endpoint a window is kept for. */
export function limitKey(account: string, method: string, path: string): string {
  return `${account} ${endpointOf(method, path)}`;
}

/** What a response says of its endpoint's limit; nothing when it does not say both. */
export function recordLimit(key: string, headers: Headers, now = Date.now()): void {
  const remaining = Number(headers.get("x-ratelimit-remaining") ?? NaN);
  const resetAt = Number(headers.get("x-ratelimit-reset") ?? NaN);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt) || remaining < 0 || resetAt <= 0) return;
  const reset = Math.min(resetAt > 1e10 ? resetAt : resetAt * 1000, now + MAX_RESET_MS);
  if (reset <= now) { windows.delete(key); return; }
  windows.delete(key);
  windows.set(key, { remaining: Math.floor(remaining), reset });
  if (windows.size > MAX_WINDOWS) windows.delete(windows.keys().next().value!);
}

/**
 * How long a request to this endpoint must wait before it is sent: 0 when the last response left requests, or its
 * window has reset. A request counted here is taken from what is left, so callers at once do not all spend the last.
 */
export function waitFor(key: string, now = Date.now()): number {
  const window = windows.get(key);
  if (!window) return 0;
  if (window.reset <= now) {
    // A window used up: this request goes first, and the others wait for what its response says.
    if (window.remaining <= 0) windows.set(key, { remaining: 0, reset: now + PROBE_MS });
    else windows.delete(key);
    return 0;
  }
  if (window.remaining > 0) { window.remaining -= 1; return 0; }
  return window.reset - now;
}

/** For tests: forget every window. */
export function resetLimits(): void {
  windows.clear();
}
