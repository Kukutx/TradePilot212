import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import { endpointOf, limitKey, PROBE_MS, recordLimit, resetLimits, waitFor } from "./rate-limit.js";
import { ExecutionStatusUnknownError, Trading212ApiError, Trading212Client } from "./trading212-client.js";

const headers = (remaining: number, resetMs: number) => new Headers({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(Math.round(resetMs / 1000)) });

afterEach(() => resetLimits());

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
    await new Trading212Client("demo", config, fetcher).getAccountSummary();
    // A second client of the same account waits the second out rather than spend a 429.
    const started = Date.now();
    await new Trading212Client("demo", config, fetcher).getAccountSummary();
    expect(Date.now() - started).toBeGreaterThanOrEqual(Math.max(0, Math.ceil(reset / 1000) * 1000 - started) - 50);
    expect(sent).toHaveLength(2);
    // Now the reset is hours off: the read is refused before it is sent.
    reset = Date.now() + 3 * 3_600_000;
    await new Trading212Client("demo", config, fetcher).getPositions().catch(() => undefined);
    const refused = await new Trading212Client("demo", config, fetcher).getPositions().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Trading212ApiError);
    expect((refused as Trading212ApiError).status).toBe(429);
    expect((refused as Error).message).toMatch(/limit for GET \/equity\/positions is used up until .*; the request was not sent/);
    expect(sent).toHaveLength(3);
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
