import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { ResourceChanges, resourcesOfKey, watchingStore } from "./resource-changes.js";
import { MemoryStateStore } from "./state-store.js";

/** A sample account (nothing reaches Trading 212) with writes on, and the resource updates its client is sent. */
async function connect() {
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createMcpServer } = await import("./mcp.js");
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", TRADEPILOT_ALLOW_WRITES: "true" } as RuntimeEnv);
  const services = createServices({ config, store: new MemoryStateStore() });
  const server = createMcpServer(services, config, async () => "<html></html>");
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  const updated: string[] = [];
  client.setNotificationHandler("notifications/resources/updated", async (notification) => { updated.push(notification.params.uri); });
  await client.connect(clientSide);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
  // Notifications arrive after the call that caused them returns.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { client, call, settle, updated, server, services };
}

describe("resource subscriptions", () => {
  it("are offered, and tell a subscriber when the resource it chose changes, from any tool", async () => {
    const { client, call, settle, updated } = await connect();
    expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
    await client.subscribeResource({ uri: "tradepilot://demo/goal" });
    await client.subscribeResource({ uri: "tradepilot://demo/watchlist" });
    expect((await call("manage_goal", { action: "set", target: 50_000, by: "2035-12-31" })).isError).toBeFalsy();
    await call("manage_target_allocation", { action: "set", targets: [{ instrument: "AAPL", weight: 0.5 }] });
    await call("manage_watchlist", { action: "add", instrument: "MSFT" });
    await settle();
    // The targets were not subscribed to.
    expect([...new Set(updated)]).toEqual(["tradepilot://demo/goal", "tradepilot://demo/watchlist"]);
    await client.unsubscribeResource({ uri: "tradepilot://demo/goal" });
    updated.length = 0;
    await call("manage_goal", { action: "remove" });
    await settle();
    expect(updated).toEqual([]);
  });

  it("says the holdings changed after something is sent to Trading 212 and after the scheduler reads the account", async () => {
    const { client, call, settle, updated, services } = await connect();
    await client.subscribeResource({ uri: "tradepilot://demo/holdings" });
    const token = (await call("app_prepare_order", { environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "limit", quantity: 1, limitPrice: 100 })).structuredContent!.token;
    await call("app_execute_order", { token });
    await settle();
    expect(updated).toContain("tradepilot://demo/holdings");
    updated.length = 0;
    // A holdings read just before the scheduler's is not served again after it says they changed.
    const before = await client.readResource({ uri: "tradepilot://demo/holdings" });
    await services.runScheduled();
    await settle();
    expect(updated).toContain("tradepilot://demo/holdings");
    expect(before.contents).toHaveLength(1);
    const kept = services.trading["dashboards" as keyof typeof services.trading] as unknown as Map<string, unknown>;
    expect(kept.has("demo")).toBe(false);
  });

  it("ignores a subscription to an address the server does not list, and stops when the connection closes", async () => {
    const { client, call, settle, updated, server } = await connect();
    await client.subscribeResource({ uri: "tradepilot://live/goal" });
    await client.subscribeResource({ uri: "tradepilot://demo/goal" });
    await server.close();
    await call("manage_goal", { action: "set", target: 50_000, by: "2035-12-31" }).catch(() => undefined);
    await settle();
    expect(updated).toEqual([]);
  });

  it("knows which resource each saved key belongs to, and says so once a write is in", async () => {
    expect(resourcesOfKey("goal:live")).toEqual([["live", "goal"]]);
    expect(resourcesOfKey("goal-milestone:demo")).toEqual([["demo", "goal"]]);
    expect(resourcesOfKey("targets:demo")).toEqual([["demo", "targets"]]);
    expect(resourcesOfKey("watch:live:AAPL_US_EQ")).toEqual([["live", "watchlist"]]);
    expect(resourcesOfKey("journal:abc", { environment: "live" })).toEqual([["live", "journal"]]);
    expect(resourcesOfKey("journal:abc")).toEqual([["demo", "journal"], ["live", "journal"]]);
    expect(resourcesOfKey("journal-order:demo:1")).toEqual([]);
    expect(resourcesOfKey("confirm:token")).toEqual([]);
    const changes = new ResourceChanges();
    const heard: string[] = [];
    const stop = changes.on((uri) => heard.push(uri));
    changes.on(() => { throw new Error("a broken subscriber"); });
    const store = watchingStore(new MemoryStateStore(), changes);
    await store.put("goal:demo", { target: 1 });
    expect(await store.get("goal:demo")).toEqual({ target: 1 });
    await store.delete("watch:demo:AAPL_US_EQ");
    await store.put("confirm:x", {});
    expect(await store.consume("confirm:x")).toEqual({});
    stop();
    await store.put("targets:demo", {});
    expect(heard).toEqual(["tradepilot://demo/goal", "tradepilot://demo/watchlist"]);
  });
});
