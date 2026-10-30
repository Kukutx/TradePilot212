// Holds TradePilot to Trading 212's published API without a network: every request the client can send, run against
// the sample broker, must be an operation of the OpenAPI document (docs/api/trading212-public-api-v0.json) with only
// its documented query parameters and body fields, and every field the sample broker answers with must be one the
// document lists, so the sample account looks like the real one. Update the file from the document when Trading 212
// changes the API, then run `pnpm check:api`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { InsightsService, parseWindow } from "./insights-service.js";
import { createSampleBroker } from "./sample-broker.js";
import { MemoryStateStore } from "./state-store.js";
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

/**
 * A body's or a response's fields as the document names them: `a.b` inside objects, `[]` for each item of a list. A
 * field the document lists as a whole (a map such as `instrumentShares`) is not looked into; an empty list or object
 * is a field of its own, so an unlisted one is not missed.
 */
function fields(value: unknown, known: Set<string>, prefix = ""): string[] {
  if (Array.isArray(value)) return value.length ? [...new Set(value.flatMap((item) => fields(item, known, `${prefix}[]`)))] : known.has(prefix) || [...known].some((key) => key.startsWith(`${prefix}[]`)) ? [] : [prefix];
  if (value === null || typeof value !== "object" || (prefix && known.has(prefix))) return prefix ? [prefix] : [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return prefix ? [prefix] : [];
  return entries.flatMap(([key, inner]) => fields(inner, known, prefix ? `${prefix}.${key}` : key));
}

interface Sent { operation: string; query: string[]; limit?: number; body: string[]; response: unknown }

/** A fetcher to the sample broker that keeps each request and its answer; nothing leaves the process. */
function recording() {
  const sent: Sent[] = [];
  const broker = createSampleBroker((async () => new Response("{}", { status: 599 })) as typeof fetch);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = operation(method, template(url.pathname));
    const response = await broker(input, init);
    const text = await response.clone().text();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const limit = url.searchParams.get("limit");
    sent.push({
      operation: key, query: [...url.searchParams.keys()], ...(limit === null ? {} : { limit: Number(limit) }),
      body: body === undefined ? [] : fields(body, new Set(api.requests[key] ?? [])), response: text ? JSON.parse(text) : undefined,
    });
    return response;
  }) as typeof fetch;
  return { sent, fetcher };
}

/** The client, against the sample broker, with each request and its answer kept. */
function recordedClient() {
  const { sent, fetcher } = recording();
  return { client: new Trading212Client("demo", createConfig({ TRADEPILOT_SAMPLE_DATA: "true" }), fetcher), sent };
}

/** Everything the client can ask of Trading 212, once each. */
async function everyRequest() {
  const { client, sent } = recordedClient();
  await client.getAccountSummary();
  await client.getPositions();
  await client.getInstruments();
  await client.getExchanges();
  // Every page, by the nextPagePath each answer gives, as the history reads do; once for one instrument.
  for (const kind of ["orders", "dividends", "transactions"] as const) {
    for (let page = await client.getHistoryPage(kind); page.nextPagePath;) page = await client.getHistoryPage(kind, page.nextPagePath);
    await client.getHistoryPage(kind, undefined, "AAPL_US_EQ");
  }
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
    const sent = await everyRequest();
    for (const item of sent) {
      const spec = api.operations.find((entry) => operation(entry.method, entry.path) === item.operation)!;
      expect(item.query.filter((key) => !spec.query.includes(key)), item.operation).toEqual([]);
      expect(item.body.filter((key) => !(api.requests[item.operation] ?? []).includes(key)), item.operation).toEqual([]);
      // Trading 212 serves at most 50 records a page.
      if (item.limit !== undefined) expect(item.limit, item.operation).toBeLessThanOrEqual(50);
    }
    // The later pages were read too, with the cursor their nextPagePath gave.
    expect(sent.filter((item) => item.query.includes("cursor")).map((item) => item.operation)).toEqual(expect.arrayContaining(["GET /api/v0/equity/history/orders", "GET /api/v0/equity/history/dividends"]));
  });

  it("is sent only documented fields in the bodies TradePilot builds: a pie and a report", async () => {
    const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
    const services = createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}", { status: 599 })) as typeof fetch });
    const pie = { name: "Test", icon: "Home", goal: 1000, endDate: new Date(Date.now() + 400 * 86_400_000).toISOString(), dividendCashAction: "TO_ACCOUNT_CASH" as const, instrumentShares: { AAPL: 0.5, MSFT_US_EQ: 0.5 } };
    const pies = await services.pies.listPies("demo");
    for (const draft of [{ environment: "demo" as const, action: "create" as const, ...pie }, { environment: "demo" as const, action: "update" as const, pieId: pies.pies[0]!.id, ...pie }]) {
      const preview = await services.pies.preparePieChange(draft);
      const key = draft.action === "create" ? "POST /api/v0/equity/pies" : "POST /api/v0/equity/pies/{id}";
      const listed = new Set(api.requests[key]);
      expect(fields(preview.request, listed).filter((field) => !listed.has(field)), key).toEqual([]);
    }
    const { sent, fetcher } = recording();
    // A span no report the sample account holds covers, so one is asked for.
    await new InsightsService({ config, fetcher, instruments: async () => [] }).requestExport("demo", parseWindow({ from: "2020-01-01" }));
    const asked = sent.find((item) => item.operation === "POST /api/v0/equity/history/exports")!;
    expect(asked.body.filter((field) => !api.requests[asked.operation]!.includes(field))).toEqual([]);
    expect(asked.body).toHaveLength(6);
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
      expect(api.enums["Order.side"]).toContain(order.side);
      if (order.timeInForce !== undefined) expect(api.enums.timeValidity).toContain(order.timeInForce);
    }
    // Every type the sample account's cash history has, over all its pages.
    const types = sent.filter((item) => item.operation === "GET /api/v0/equity/history/transactions").flatMap((item) => (item.response as { items: Array<{ type: string }> }).items.map((entry) => entry.type));
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((type) => !api.enums["Transaction.type"]!.includes(type))).toEqual([]);
  });
});
