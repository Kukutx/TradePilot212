import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeConfig, type RuntimeEnv } from "./config.js";
import { HistoryLedgers } from "./history-ledger.js";
import { InsightsService } from "./insights-service.js";
import { readCancelled, readWatch, toolCallWatch, watchingReads } from "./request-context.js";
import { MemoryStateStore } from "./state-store.js";
import { APP_ICON_DATA_URI, APP_META } from "../shared/meta.js";

const config = {
  trading212: {
    demo: { baseUrl: "https://demo.test/api/v0", apiKey: "key", apiSecret: "secret" },
    live: { baseUrl: "https://live.test/api/v0", apiKey: "", apiSecret: "" },
  },
} as RuntimeConfig;

/** Five pages of transactions, newest first, each pointing to the next. */
function pagedFetcher(calls: string[]): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const n = Number(new URL(url).searchParams.get("cursor") ?? 1);
    return Response.json({ items: [{ dateTime: `2026-09-${String(10 - n).padStart(2, "0")}T00:00:00Z`, amount: n }], nextPagePath: n < 5 ? `/api/v0/equity/history/transactions?cursor=${n + 1}` : null });
  }) as typeof fetch;
}

describe("read watch", () => {
  it("is the one the read runs under, down through its awaits, and none outside", async () => {
    expect(readWatch()).toBeUndefined();
    const controller = new AbortController();
    await watchingReads({ signal: controller.signal }, async () => {
      await Promise.resolve();
      expect(readCancelled()).toBe(false);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readCancelled()).toBe(true);
    });
    expect(readCancelled()).toBe(false);
  });

  it("tells each history page read, and a cancelled call reads no further and is not kept", async () => {
    const calls: string[] = [];
    const service = new InsightsService({ config, instruments: async () => [], fetcher: pagedFetcher(calls) });
    let pages = 0;
    const whole = await watchingReads({ page: () => { pages += 1; } }, () => service.collect("demo", "transactions", { to: new Date() }, 10));
    expect(whole.items).toHaveLength(5);
    expect(pages).toBe(5);

    const other = new InsightsService({ config, instruments: async () => [], fetcher: pagedFetcher(calls) });
    calls.length = 0;
    const controller = new AbortController();
    const cut = await watchingReads({ signal: controller.signal, page: () => { if (calls.length === 2) controller.abort(); } }, () => other.collect("demo", "transactions", { to: new Date() }, 10));
    expect(cut.items).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    // Cancelled, the call reads no other history either.
    calls.length = 0;
    const after = await watchingReads({ signal: controller.signal }, () => other.collect("demo", "dividends", { to: new Date() }, 10));
    expect(after).toEqual({ items: [], truncated: true });
    expect(calls).toHaveLength(0);
    // Not kept: read again, it reads every page.
    calls.length = 0;
    expect((await other.collect("demo", "transactions", { to: new Date() }, 10)).items).toHaveLength(5);
    expect(calls).toHaveLength(5);
  });

  it("keeps in the ledger what a cancelled call read, and the next read goes on from there", async () => {
    const calls: string[] = [];
    const service = new InsightsService({ config, instruments: async () => [], fetcher: pagedFetcher(calls), ledgers: new HistoryLedgers(new MemoryStateStore()) });
    const controller = new AbortController();
    const cut = await watchingReads({ signal: controller.signal, page: () => { if (calls.length === 2) controller.abort(); } }, () => service.collect("demo", "transactions", { to: new Date() }, 10));
    expect(calls).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    calls.length = 0;
    const rest = await service.collect("demo", "transactions", { to: new Date() }, 10);
    expect(rest.items.map((item) => item.amount).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(rest.truncated).toBe(false);
    // The newest page again, then on from the third.
    expect(calls.filter((url) => /cursor=[345]/.test(url))).toHaveLength(3);
    expect(calls.some((url) => /cursor=2/.test(url))).toBe(false);
  });

  it("sends progress only when the call asked for it, and never fails a read on a notification", async () => {
    const sent: unknown[] = [];
    const notify = async (notification: unknown) => { sent.push(notification); throw new Error("closed"); };
    expect(toolCallWatch(undefined)).toEqual({});
    expect(toolCallWatch({ mcpReq: { notify } }).page).toBeUndefined();
    const watch = toolCallWatch({ mcpReq: { notify, _meta: { progressToken: "t1" } } });
    watch.page!();
    watch.page!();
    await Promise.resolve();
    expect(sent).toEqual([
      { method: "notifications/progress", params: { progressToken: "t1", progress: 1, message: "Read 1 history page" } },
      { method: "notifications/progress", params: { progressToken: "t1", progress: 2, message: "Read 2 history pages" } },
    ]);
  });
});

describe("the MCP server", () => {
  async function connect() {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const runtime = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" } as RuntimeEnv);
    const services = createServices({ config: runtime, store: new MemoryStateStore() });
    const server = createMcpServer(services, runtime, async () => "<html></html>");
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  it("names itself with a title, a website and its icon", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "tradepilot212", title: APP_META.name, version: APP_META.version, websiteUrl: APP_META.websiteUrl, icons: [{ src: APP_ICON_DATA_URI, mimeType: "image/svg+xml" }] });
    expect(atob(APP_ICON_DATA_URI.split(",")[1]!)).toMatch(/^<svg [^>]*viewBox="0 0 64 64"/);
  });

  it("reports a history read's pages to a client that asked for progress", async () => {
    const client = await connect();
    const progress: Array<{ progress: number }> = [];
    const reply = await client.callTool({ name: "get_trade_history", arguments: { environment: "demo", period: "all" } }, { onprogress: (update) => { progress.push(update); } });
    expect(reply.isError).toBeFalsy();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.map((update) => update.progress)).toEqual(progress.map((_, index) => index + 1));
  });
});
