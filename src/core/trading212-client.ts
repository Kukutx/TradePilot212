import type { AccountSummary, Instrument, OrderDraft, PendingOrder, Position, TradingEnvironment } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";

export class Trading212ApiError extends Error {
  constructor(message: string, readonly status: number, readonly responseBody: unknown) { super(message); this.name = "Trading212ApiError"; }
}
export class ExecutionStatusUnknownError extends Error {
  constructor(message: string, readonly causeValue?: unknown) { super(message); this.name = "ExecutionStatusUnknownError"; }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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

export class Trading212Client {
  private readonly target;
  private readonly fetcher: typeof fetch;
  constructor(readonly environment: TradingEnvironment, config: RuntimeConfig, fetcher?: typeof fetch) {
    this.target = config.trading212[environment];
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
    if (!this.target.apiKey || !this.target.apiSecret) throw new Error(`Trading 212 ${environment.toUpperCase()} API credentials are not configured`);
  }
  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const attempts = method === "GET" ? 4 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.target.baseUrl}${path}`, { method, headers: {
          Authorization: `Basic ${basic(`${this.target.apiKey}:${this.target.apiSecret}`)}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      } catch (error) {
        if (method !== "GET") throw new ExecutionStatusUnknownError("Trading 212 did not return a response. The order/cancel status is unknown; verify the order list before trying again.", error);
        if (attempt === attempts) throw error; await sleep(Math.min(300 * 2 ** (attempt - 1), 5000)); continue;
      }
      const parsed = await readBody(response); if (response.ok) return parsed as T;
      if (method !== "GET" && (response.status === 408 || response.status >= 500))
        throw new ExecutionStatusUnknownError(`Trading 212 returned ${response.status} after a write. Execution status is unknown; refresh orders before trying again.`, parsed);
      if (method === "GET" && (response.status === 408 || response.status === 429 || response.status >= 500) && attempt < attempts) {
        await sleep(retryDelayMs(response, attempt)); continue;
      }
      const detail = parsed == null || parsed === "" ? "" : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Trading212ApiError(`Trading 212 ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`, response.status, parsed);
    }
    throw new Error("Unreachable Trading 212 request state");
  }
  getAccountSummary() { return this.request<AccountSummary>("GET", "/equity/account/summary"); }
  async getPositions() { return unwrapArray<Position>(await this.request("GET", "/equity/positions")); }
  async getOrders() { return unwrapArray<PendingOrder>(await this.request("GET", "/equity/orders")); }
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
}
