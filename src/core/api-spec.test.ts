// Holds TradePilot to Trading 212's published API without a network: every request the client can send, run against
// the sample broker, must be an operation of the OpenAPI document (docs/api/trading212-public-api-v0.json) with only
// its documented query parameters and body fields, and every field the sample broker answers with must be one the
// document lists, so the sample account looks like the real one. Update the file from the document when Trading 212
// changes the API, then run `pnpm check:api`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import { createSampleBroker } from "./sample-broker.js";
import { Trading212Client } from "./trading212-client.js";

interface ApiDocument {
  operations: Array<{ method: string; path: string; query: string[]; rateLimit: string }>;
  responses: Record<string, string[]>;
  requests: Record<string, string[]>;
  enums: Record<string, string[]>;
}

const api = JSON.parse(readFileSync(new URL("../../docs/api/trading212-public-api-v0.json", import.meta.url), "utf8")) as ApiDocument;
const operation = (method: string, path: string) => `${method} ${path}`;
const documented = new Set(api.operations.map((item) => operation(item.method, item.path)));

/** An id in a path is the document's `{id}`. */
const template = (path: string) => path.replace(/\/\d+(?=\/|$)/g, "/{id}");

/** A body's or a response's fields as the document names them: `a.b` inside objects, `[]` for each item of a list. */
function fields(value: unknown, known: Set<string>, prefix = ""): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => fields(item, known, `${prefix}[]`)))];
  if (value === null || typeof value !== "object" || (prefix && known.has(prefix))) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => fields(inner, known, prefix ? `${prefix}.${key}` : key));
}

interface Sent { operation: string; query: string[]; body: string[]; response: unknown }

/** The client, against the sample broker, with each request and its answer kept. */
function recordedClient() {
  const sent: Sent[] = [];
  const broker = createSampleBroker((async () => new Response("{}", { status: 599 })) as typeof fetch);
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = operation(method, template(url.pathname));
    const response = await broker(input, init);
    const text = await response.clone().text();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ operation: key, query: [...url.searchParams.keys()], body: body === undefined ? [] : fields(body, new Set(api.requests[key] ?? [])), response: text ? JSON.parse(text) : undefined });
    return response;
  }) as typeof fetch;
  return { client: new Trading212Client("demo", createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), recording), sent };
}

/** Everything the client can ask of Trading 212, once each. */
async function everyRequest() {
  const { client, sent } = recordedClient();
  await client.getAccountSummary();
  await client.getPositions();
  await client.getInstruments();
  await client.getExchanges();
  for (const kind of ["orders", "dividends", "transactions"] as const) await client.getHistoryPage(kind, undefined, "AAPL_US_EQ");
  await client.listExports();
  await client.requestExport({ timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-02-01T00:00:00Z", dataIncluded: { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true } });
  await client.placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 1, extendedHours: false });
  const limit = await client.placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "limit", quantity: 1, limitPrice: 100, timeValidity: "GOOD_TILL_CANCEL" }) as { id: number };
  await client.placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "stop", quantity: 1, stopPrice: 100 });
  await client.placeOrder({ environment: "demo", ticker: "AAPL_US_EQ", side: "sell", type: "stop_limit", quantity: 1, stopPrice: 100, limitPrice: 99 });
  await client.getOrders();
  await client.getOrder(String(limit.id));
  await client.cancelOrder(String(limit.id));
  const pies = await client.getPies();
  await client.getPie(pies[0]!.id);
  const created = await client.createPie({ name: "Test", icon: "Home", dividendCashAction: "REINVEST", instrumentShares: { AAPL_US_EQ: 1 } });
  const id = (created as { settings: { id: number } }).settings.id;
  await client.updatePie(id, { name: "Test 2", icon: "Home", dividendCashAction: "TO_ACCOUNT_CASH", instrumentShares: { AAPL_US_EQ: 0.5, MSFT_US_EQ: 0.5 } });
  await client.duplicatePie(id, { name: "Copy" });
  await client.deletePie(id);
  return sent;
}

describe("Trading 212's published API", () => {
  it("is used in full: every documented operation, and only those", async () => {
    const sent = await everyRequest();
    expect(new Set(sent.map((item) => item.operation))).toEqual(documented);
  });

  it("is sent only documented query parameters and body fields", async () => {
    for (const item of await everyRequest()) {
      const spec = api.operations.find((entry) => operation(entry.method, entry.path) === item.operation)!;
      expect(item.query.filter((key) => !spec.query.includes(key)), item.operation).toEqual([]);
      expect(item.body.filter((key) => !(api.requests[item.operation] ?? []).includes(key)), item.operation).toEqual([]);
    }
  });

  it("is what the sample account answers with: no field the document does not list", async () => {
    const checked = new Set<string>();
    for (const item of await everyRequest()) {
      const listed = api.responses[item.operation];
      if (!listed || item.response === undefined) continue;
      checked.add(item.operation);
      const known = new Set(listed);
      expect(fields(item.response, known).filter((key) => !known.has(key)), item.operation).toEqual([]);
    }
    expect(checked).toEqual(new Set(Object.keys(api.responses)));
  });

  it("is answered with the document's enums by the sample account", async () => {
    const sent = await everyRequest();
    const orders = sent.filter((item) => item.operation === "GET /api/v0/equity/orders").flatMap((item) => item.response as Array<Record<string, unknown>>);
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) {
      expect(api.enums["Order.status"]).toContain(order.status);
      expect(api.enums["Order.type"]).toContain(order.type);
      expect(api.enums["Order.strategy"]).toContain(order.strategy);
      if (order.timeInForce !== undefined) expect(api.enums.timeValidity).toContain(order.timeInForce);
    }
    const transactions = sent.find((item) => item.operation === "GET /api/v0/equity/history/transactions")!.response as { items: Array<{ type: string }> };
    // Only the history of one instrument was asked for, so read every type the sample account has.
    const { client, sent: all } = recordedClient();
    await client.getHistoryPage("transactions");
    const types = (all[0]!.response as { items: Array<{ type: string }> }).items.map((item) => item.type);
    expect(types.filter((type) => !api.enums["Transaction.type"]!.includes(type))).toEqual([]);
    expect(transactions.items.every((item) => api.enums["Transaction.type"]!.includes(item.type))).toBe(true);
  });
});
