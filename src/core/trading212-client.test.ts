import { describe, expect, it, vi } from "vitest";
import { createConfig } from "./config.js";
import { ExecutionStatusUnknownError, Trading212ApiError, Trading212Client } from "./trading212-client.js";
import type { OrderDraft } from "../shared/contracts.js";

const draft: OrderDraft = {
  environment: "demo", ticker: "AAPL_US_EQ", side: "buy",
  type: "market", quantity: 0.5, referencePrice: 100,
};
const config = createConfig({ T212_DEMO_API_KEY: "test-key", T212_DEMO_API_SECRET: "test-secret" });

describe("broker write transport", () => {
  it("never retries when a write returns a network failure", async () => {
    const fetcher = vi.fn(async () => { throw new Error("connection reset"); });
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await expect(client.placeOrder(draft)).rejects.toBeInstanceOf(ExecutionStatusUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable successful response as UNKNOWN, not rejected", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("body connection dropped")); },
    }), { status: 200 }));
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await expect(client.placeOrder(draft)).rejects.toBeInstanceOf(ExecutionStatusUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats an oversized write response as UNKNOWN and does not retry", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(300_000), { status: 201 }));
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await expect(client.placeOrder(draft)).rejects.toBeInstanceOf(ExecutionStatusUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries a known broker-side validation rejection", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: "Invalid order" }), { status: 400 }));
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await expect(client.placeOrder(draft)).rejects.toBeInstanceOf(Trading212ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries an uncertain HTTP 503 write response", async () => {
    const fetcher = vi.fn(async () => new Response("Service unavailable", { status: 503 }));
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await expect(client.placeOrder(draft)).rejects.toBeInstanceOf(ExecutionStatusUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends sell orders as negative quantities", async () => {
    const fetcher = vi.fn(async (_: unknown, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toMatchObject({ ticker: "AAPL_US_EQ", quantity: -0.5 });
      return new Response("{}", { status: 200 });
    });
    const client = new Trading212Client("demo", config, fetcher as typeof fetch);
    await client.placeOrder({ ...draft, side: "sell" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
