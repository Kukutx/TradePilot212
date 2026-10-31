import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { confirmationMessage, confirmInHost } from "./order-confirm.js";
import { MemoryStateStore } from "./state-store.js";

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> };
const leg = { ticker: "AAPL_US_EQ", side: "buy", type: "limit", quantity: 1, limitPrice: 100 };

/** A sample account (nothing reaches Trading 212) served to a client that can show forms, or renders the widget. */
async function connect(options: { answer?: Answer; ui?: boolean; elicitation?: boolean } = {}) {
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createMcpServer } = await import("./mcp.js");
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", TRADEPILOT_ALLOW_WRITES: "true" } as RuntimeEnv);
  const server = createMcpServer(createServices({ config, store: new MemoryStateStore() }), config, async () => "<html></html>");
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const capabilities = {
    ...(options.elicitation === false ? {} : { elicitation: { form: {} } }),
    ...(options.ui ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}),
  };
  const client = new Client({ name: "test", version: "0" }, { capabilities });
  const asked: Array<{ message: string; requestedSchema: { properties: Record<string, unknown>; required?: string[] } }> = [];
  if (options.elicitation !== false) {
    client.setRequestHandler("elicitation/create", async (request) => {
      asked.push(request.params as (typeof asked)[number]);
      return options.answer ?? { action: "accept", content: { send: true } };
    });
  }
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
  const token = async (name: string, args: Record<string, unknown>) => (await call(name, args)).structuredContent!.token as string;
  const request = async (params: Record<string, unknown>) => (await (client as unknown as { request: (message: unknown) => Promise<unknown> }).request({ method: "tools/call", params })) as { structuredContent?: Record<string, unknown> };
  return { call, token, asked, request };
}

describe("confirming in a host without the widget", () => {
  it("asks the user in the host's own form before an order is sent, and sends on their yes", async () => {
    const { call, token, asked } = await connect();
    const sent = await call("app_execute_order", { token: await token("app_prepare_order", { ...leg, environment: "demo" }) });
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent).toMatchObject({ kind: "order_execution", ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toBe("Send this order to your Trading 212 DEMO account?\n- Buy 1 AAPL_US_EQ, limit 100");
    expect(asked[0]!.requestedSchema.required).toEqual(["send"]);
  });

  it("sends nothing when the form is declined, and the token can still be confirmed", async () => {
    const declined = await connect({ answer: { action: "decline" } });
    const code = await declined.token("app_prepare_order", { ...leg, environment: "demo" });
    const refused = await declined.call("app_execute_order", { token: code });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_DECLINED" } });
    // An unticked box counts as no.
    const unticked = await connect({ answer: { action: "accept", content: { send: false } } });
    const basket = await unticked.call("app_execute_basket", { token: await unticked.token("app_prepare_basket", { environment: "demo", purpose: "custom", title: "Two", drafts: [{ ...leg, environment: "demo" }] }) });
    expect(basket.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_DECLINED" } });
    expect(unticked.asked[0]!.message).toContain('Send the basket "Two", 1 order, to your Trading 212 DEMO account?');
  });

  it("shows the form to a client that sends an answer to no form along with the call", async () => {
    const { token, asked, request } = await connect({ answer: { action: "decline" } });
    const code = await token("app_prepare_order", { ...leg, environment: "demo" });
    const sent = await request({ name: "app_execute_order", arguments: { token: code }, inputResponses: { confirm: { action: "accept", content: { send: true } } } });
    expect(asked).toHaveLength(1);
    expect(sent.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_DECLINED" } });
  });

  it("asks about cancellations and pie changes too", async () => {
    const { call, token, asked } = await connect();
    expect((await call("app_execute_cancel", { token: await token("app_prepare_cancel", { environment: "demo", orderId: "81234" }) })).isError).toBeFalsy();
    expect((await call("app_execute_pie_change", { token: await token("app_prepare_pie_change", { environment: "demo", action: "update", pieId: 4101, name: "Renamed" }) })).isError).toBeFalsy();
    expect(asked.map((one) => one.message)).toEqual([
      "Cancel order 81234 in your Trading 212 DEMO account? If it is a stop-loss, the position is no longer protected.",
      'Change pie 4101 in your Trading 212 DEMO account? It will be named "Renamed".\nShares:\n- NVDA_US_EQ 50%\n- MSFT_US_EQ 30%\n- AAPL_US_EQ 20%',
    ]);
  });

  it("says when a token has expired without asking, and never asks a host that renders the widget or cannot ask", async () => {
    const asking = await connect();
    expect((await asking.call("app_execute_order", { token: "x".repeat(24) })).structuredContent).toMatchObject({ error: { code: "CONFIRMATION_EXPIRED" } });
    expect(asking.asked).toHaveLength(0);
    for (const options of [{ ui: true }, { elicitation: false }]) {
      const host = await connect(options);
      const sent = await host.call("app_execute_order", { token: await host.token("app_prepare_order", { ...leg, environment: "demo" }) });
      expect(sent.structuredContent, JSON.stringify(options)).toMatchObject({ ok: true });
      expect(host.asked).toHaveLength(0);
    }
  });

  it("needs the real-money box ticked for Live, and then counts as the Live acknowledgement", async () => {
    // An empty elicitation capability is the form mode.
    const server = { server: { getClientCapabilities: () => ({ elicitation: {} }) } } as unknown as Parameters<typeof confirmInHost>[0];
    const describe = async () => ({ kind: "cancel" as const, environment: "live" as const, orderId: "7" });
    /** Ask about the token, and the call that comes back with the answer and the state the form was asked with. */
    const ask = async (token: string) => {
      const first = await confirmInHost(server, {}, token, describe);
      expect(first.send).toBe(false);
      const state = (first as { ask: { requestState: string } }).ask.requestState;
      return { first, answered: (content: Record<string, unknown>, sent = state) => ({ mcpReq: { inputResponses: { confirm: { action: "accept", content } }, requestState: () => sent } }) };
    };
    const once = await ask("token-a");
    expect(JSON.stringify(once.first)).toContain('"required":["send","realMoney"]');
    await expect(confirmInHost(server, once.answered({ send: true }), "token-a", describe)).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED" });
    const twice = await ask("token-a");
    expect(await confirmInHost(server, twice.answered({ send: true, realMoney: true }), "token-a", describe)).toEqual({ send: true, liveAcknowledged: true });
    // An answer counts once, for the token it was asked about, and only with the state it was asked with.
    expect((await confirmInHost(server, twice.answered({ send: true, realMoney: true }), "token-a", describe)).send).toBe(false);
    const other = await ask("token-b");
    expect((await confirmInHost(server, other.answered({ send: true, realMoney: true }), "token-c", describe)).send).toBe(false);
    expect((await confirmInHost(server, other.answered({ send: true, realMoney: true }, "made-up"), "token-b", describe)).send).toBe(false);
    // A URL-only capability cannot show the form.
    const urlOnly = { server: { getClientCapabilities: () => ({ elicitation: { url: {} } }) } } as unknown as Parameters<typeof confirmInHost>[0];
    expect(await confirmInHost(urlOnly, {}, "token-d", describe)).toEqual({ send: true, liveAcknowledged: false });
  });

  it("words a Live form with the real-money box, a long basket counted and Chinese", () => {
    const drafts = Array.from({ length: 12 }, (_, index) => ({ environment: "live" as const, ticker: `T${index}`, side: "sell" as const, type: "stop" as const, quantity: 2, stopPrice: 9, timeValidity: "GOOD_TILL_CANCEL" as const }));
    expect(confirmationMessage({ kind: "basket", environment: "live", title: "Stops", drafts }).split("\n").slice(0, 2)).toEqual([
      'Send the basket "Stops", 12 orders, to your Trading 212 LIVE account?',
      "- Sell 2 T0, stop 9, good till cancelled",
    ]);
    expect(confirmationMessage({ kind: "basket", environment: "live", title: "Stops", drafts }).split("\n").at(-1)).toBe("- and 2 more");
    expect(confirmationMessage({ kind: "order", environment: "live", drafts: [{ environment: "live", ticker: "VUSA_EQ", side: "buy", type: "market", quantity: 3 }] }, "zh-CN"))
      .toBe("把这笔订单发送到你的 Trading 212 实盘账户？\n- 买入 3 股 VUSA_EQ，市价");
    expect(confirmationMessage({ kind: "pie", environment: "demo", action: "duplicate", pieId: 4101, name: "Copy" })).toBe('Duplicate pie 4101 as "Copy" in your Trading 212 DEMO account?');
    expect(confirmationMessage({ kind: "pie", environment: "demo", action: "delete", pieId: 4101 }, "zh-CN")).toBe("删除你 Trading 212 模拟账户里的组合 4101？");
  });
});
