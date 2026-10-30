import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig } from "./config.js";
import { endpointOf, limitKey, PROBE_MS, recordLimit, resetLimits, waitFor } from "./rate-limit.js";
import { ExecutionStatusUnknownError, resetSharedReads, shareReadsOnTheirWay, Trading212ApiError, Trading212Client } from "./trading212-client.js";

const headers = (remaining: number, resetMs: number) => new Headers({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(Math.round(resetMs / 1000)) });

afterEach(() => { resetLimits(); resetSharedReads(); shareReadsOnTheirWay(true); vi.restoreAllMocks(); });

describe("rate limits", () => {
  it("counts the pages of a history and the orders by id under one endpoint each", () => {
    expect(endpointOf("GET", "/equity/history/orders?limit=50&cursor=171&ticker=AAPL_US_EQ")).toBe("GET /equity/history/orders");
    expect(endpointOf("GET", "/equity/orders/12345")).toBe("GET /equity/orders/{id}");
    expect(endpointOf("DELETE", "/equity/orders/12345")).toBe("DELETE /equity/orders/{id}");
    expect(endpointOf("POST", "/equity/pies/77/duplicate")).toBe("POST /equity/pies/{id}/duplicate");
    expect(endpointOf("POST", "/equity/orders/stop_limit")).toBe("POST /equity/orders/stop_limit");
  });

  it("takes each request from what is left, and waits for the reset once nothing is", () => {
    const now = 1_800_000_000_000;
    const key = limitKey("demo", "GET", "/equity/history/orders");
    expect(waitFor(key, now)).toBe(0);
    recordLimit(key, headers(2, now + 30_000), now);
    expect(waitFor(key, now)).toBe(0);
    expect(waitFor(key, now)).toBe(0);
    // Two callers at once spent the last two; the third waits for the reset.
    expect(waitFor(key, now)).toBe(30_000);
    // At the reset one goes first; the rest wait for what its response says rather than all going at once.
    expect(waitFor(key, now + 30_000)).toBe(0);
    expect(waitFor(key, now + 30_000)).toBe(PROBE_MS);
    recordLimit(key, headers(5, now + 90_000), now + 30_500);
    expect(waitFor(key, now + 30_500)).toBe(0);
    // A response that says a reset already past, or one too far off to be a real window, is not held for long.
    recordLimit(key, headers(0, now - 1000), now);
    expect(waitFor(key, now)).toBe(0);
    recordLimit(key, new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9000000000000000" }), now);
    expect(waitFor(key, now)).toBe(5 * 60_000);
    resetLimits();
    // A response that does not say both leaves nothing to wait for.
    recordLimit(key, new Headers({ "x-ratelimit-remaining": "0" }), now);
    expect(waitFor(key, now)).toBe(0);
    // Another account's limit is its own.
    recordLimit(limitKey("live", "GET", "/equity/history/orders"), headers(0, now + 30_000), now);
    expect(waitFor(key, now)).toBe(0);
  });

  it("paces one account's clients: a read waits for the reset, and one too far off is not sent", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "key", T212_DEMO_API_SECRET: "secret" });
    const sent: string[] = [];
    let reset = Date.now() + 1200;
    const fetcher = (async (input: URL | RequestInfo) => {
      sent.push(String(input));
      return new Response(JSON.stringify({ currency: "EUR", totalValue: 1 }), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(reset / 1000)) } });
    }) as typeof fetch;
    // Exchanges, as their answer is not kept for other readers (the account summary's is, below).
    await new Trading212Client("demo", config, fetcher).getExchanges();
    // A second client of the same account waits the second out rather than spend a 429.
    const started = Date.now();
    await new Trading212Client("demo", config, fetcher).getExchanges();
    expect(Date.now() - started).toBeGreaterThanOrEqual(Math.max(0, Math.ceil(reset / 1000) * 1000 - started) - 50);
    expect(sent).toHaveLength(2);
    // Now the reset is hours off: the read is refused before it is sent.
    reset = Date.now() + 3 * 3_600_000;
    await new Trading212Client("demo", config, fetcher).getInstruments().catch(() => undefined);
    const refused = await new Trading212Client("demo", config, fetcher).getInstruments().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Trading212ApiError);
    expect((refused as Trading212ApiError).status).toBe(429);
    expect((refused as Error).message).toMatch(/limit for GET \/equity\/metadata\/instruments is used up until .*; the request was not sent/);
    expect(sent).toHaveLength(3);
  });

  it("shares one account's reads: one on its way is joined, and a used-up limit is answered from a moment ago", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "shared", T212_DEMO_API_SECRET: "secret" });
    const sent: string[] = [];
    let remaining = 1;
    let resetIn = 30_000;
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      sent.push(`${init?.method} ${new URL(String(input)).pathname.replace(/^\/api\/v0/, "")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const body = init?.method === "GET" ? { currency: "EUR", totalValue: sent.length } : { id: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(Math.ceil((Date.now() + resetIn) / 1000)) } });
    }) as typeof fetch;
    const client = () => new Trading212Client("demo", config, fetcher);
    // Two views opened together: one request.
    const [first, second] = await Promise.all([client().getAccountSummary(), client().getAccountSummary()]);
    expect(sent).toEqual(["GET /equity/account/summary"]);
    expect(second).toEqual(first);
    // Each caller has its own copy to change.
    expect(second).not.toBe(first);
    // The limit had one left: the next read is sent and reads afresh.
    remaining = 0;
    expect((await client().getAccountSummary()).totalValue).toBe(2);
    // Now it is used up for half a minute: the answer just given is returned rather than waiting.
    expect((await client().getAccountSummary()).totalValue).toBe(2);
    expect(sent).toHaveLength(2);
    // A read that must be current (an order's send) is not answered from a moment ago: it waits and reads again.
    resetIn = 1000;
    await client().getPositions();
    await client().getPositions();
    expect(sent).toHaveLength(3);
    await client().getPositions({ fresh: true });
    expect(sent.slice(3)).toEqual(["GET /equity/positions"]);
    // An order forgets what was kept: the read after it waits for the limit and reads again too.
    await client().getPositions();
    expect(sent).toHaveLength(4);
    await client().placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1 });
    await client().getPositions();
    expect(sent.slice(4)).toEqual(["POST /equity/orders/market", "GET /equity/positions"]);
  });

  it("joins no read on its way where that is turned off (Cloudflare), but still shares answers already given", async () => {
    shareReadsOnTheirWay(false);
    const config = createConfig({ T212_DEMO_API_KEY: "workers", T212_DEMO_API_SECRET: "secret" });
    let sent = 0;
    const fetcher = (async () => {
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ totalValue: sent }), { status: 200, headers: { "x-ratelimit-remaining": "5", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 30) } });
    }) as typeof fetch;
    await Promise.all([new Trading212Client("demo", config, fetcher).getAccountSummary(), new Trading212Client("demo", config, fetcher).getAccountSummary()]);
    expect(sent).toBe(2);
  });

  it("does not join a read on its way for longer than any read can take, so one that never ends holds nothing up", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "stuck", T212_DEMO_API_SECRET: "secret" });
    let sent = 0;
    const fetcher = (async () => {
      sent += 1;
      if (sent === 1) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ totalValue: 1 }), { status: 200 });
    }) as typeof fetch;
    void new Trading212Client("demo", config, fetcher).getAccountSummary();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start + 181_000);
    expect((await new Trading212Client("demo", config, fetcher).getAccountSummary()).totalValue).toBe(1);
    expect(sent).toBe(2);
  });

  it("forgets the kept reads of the account an order or a cancel is sent for, and only that account's", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "forget", T212_DEMO_API_SECRET: "secret", T212_LIVE_API_KEY: "other", T212_LIVE_API_SECRET: "secret" });
    const sent: string[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      sent.push(`${init?.method} ${String(input).includes("live") ? "live" : "demo"} ${new URL(String(input)).pathname.replace(/^\/api\/v0/, "")}`);
      return new Response(JSON.stringify([]), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 2) } });
    }) as typeof fetch;
    const demo = new Trading212Client("demo", config, fetcher);
    const live = new Trading212Client("live", config, fetcher);
    await Promise.all([demo.getOrders(), live.getOrders()]);
    await Promise.all([demo.getOrders(), live.getOrders()]);
    expect(sent).toHaveLength(2);
    await demo.cancelOrder("7");
    // Demo's orders are read again (after its limit's reset); Live's are still answered from a moment ago.
    await Promise.all([demo.getOrders(), live.getOrders()]);
    expect(sent.slice(2)).toEqual(["DELETE demo /equity/orders/7", "GET demo /equity/orders"]);
  });

  it("refuses an order unsent when its limit resets later than an order waits, so its status is known", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "key", T212_DEMO_API_SECRET: "secret" });
    const posts: unknown[] = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      posts.push(init?.body);
      return new Response(JSON.stringify({ id: posts.length }), { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) } });
    }) as typeof fetch;
    const draft = { environment: "demo" as const, ticker: "AAPL_US_EQ", side: "buy" as const, type: "limit" as const, quantity: 1, limitPrice: 100 };
    await new Trading212Client("demo", config, fetcher).placeOrder(draft);
    const refused = await new Trading212Client("demo", config, fetcher).placeOrder(draft).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Trading212ApiError);
    expect((refused as Trading212ApiError).status).toBe(429);
    expect(posts).toHaveLength(1);
  });
});

describe("redirects", () => {
  it("are never followed: a read fails, and a write's outcome is unknown", async () => {
    const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", T212_DEMO_BASE_URL: "https://proxy.example/api/v0" });
    const asked: RequestInit[] = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      asked.push(init!);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    }) as typeof fetch;
    const client = new Trading212Client("demo", config, fetcher);
    const read = await client.getAccountSummary().catch((error: unknown) => error);
    expect(read).toBeInstanceOf(Trading212ApiError);
    expect((read as Error).message).toMatch(/redirected \(302\).*T212_DEMO_BASE_URL/);
    const write = await client.placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1 }).catch((error: unknown) => error);
    expect(write).toBeInstanceOf(ExecutionStatusUnknownError);
    expect(asked.every((init) => init.redirect === "manual")).toBe(true);
    // Sent once each: a redirect is not retried.
    expect(asked).toHaveLength(2);
  });
});
