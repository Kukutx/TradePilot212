import { describe, expect, it } from "vitest";
import type { Instrument } from "../shared/contracts.js";
import type { PieDetail } from "../shared/pies.js";
import { createServices } from "../app/services.js";
import { createConfig } from "./config.js";
import { normaliseShares, pieOverview } from "./pies.js";
import { MemoryStateStore } from "./state-store.js";

const etf = (ticker: string): Instrument => ({ ticker, name: `${ticker} ETF`, shortName: ticker.split("_")[0]!, currencyCode: "EUR", type: "ETF" });
const instruments = [etf("VUSA_EQ"), etf("EIMI_EQ"), etf("AGGH_EQ")];

const detail: PieDetail = {
  instruments: [
    { ticker: "VUSA_EQ", expectedShare: 0.7, currentShare: 0.75, ownedQuantity: 8, result: { priceAvgValue: 750, priceAvgResult: 50 } },
    { ticker: "EIMI_EQ", expectedShare: 0.3, currentShare: 0.25, ownedQuantity: 9, result: { priceAvgValue: 250, priceAvgResult: -10 }, issues: [{ name: "DELISTED", severity: "INFORMATIVE" }] },
  ],
  settings: { id: 7, name: "Core", icon: "Home", goal: 5000, dividendCashAction: "REINVEST", instrumentShares: null },
};

/** Fake Trading 212 pies endpoints; records writes and counts reads to check the cache. */
function broker(options: { writeStatus?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v0", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (method !== "GET") {
      if (options.writeStatus) return json({ code: "Forbidden" }, options.writeStatus);
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json({ ...detail, settings: { ...detail.settings, id: path.endsWith("/duplicate") ? 8 : 9, ...(calls.at(-1)!.body as object) } });
    }
    if (path === "/equity/metadata/instruments") return json(instruments);
    if (path === "/equity/pies") return json([{ id: 7, cash: 12.5, progress: 0.2, status: "ON_TRACK", result: { priceAvgInvestedValue: 960, priceAvgValue: 1000, priceAvgResult: 40, priceAvgResultCoef: 0.0417 }, dividendDetails: { gained: 6, reinvested: 5, inCash: 1 } }]);
    if (path === "/equity/pies/7") return json(detail);
    if (path.startsWith("/equity/pies/")) return json({ code: "NotFound" }, 404);
    return json([]);
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(options: { writeStatus?: number } = {}) {
  const fake = broker(options);
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", T212_LIVE_API_KEY: "k", T212_LIVE_API_SECRET: "s" });
  return { ...createServices({ config, store: new MemoryStateStore(), fetcher: fake.fetcher }), calls: fake.calls };
}

describe("pie shares", () => {
  it("normalises shares to sum to exactly 1", () => {
    const shares = normaliseShares({ A: 1, B: 1, C: 1 });
    expect(Object.values(shares).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10);
    expect(shares).toEqual({ A: 0.3334, B: 0.3333, C: 0.3333 });
    expect(normaliseShares({ VUSA: 70, EIMI: 30 })).toEqual({ VUSA: 0.7, EIMI: 0.3 });
  });

  it("rejects empty, negative and oversized pies", () => {
    expect(() => normaliseShares({})).toThrow(/1 to 50/);
    expect(() => normaliseShares({ A: -1 })).toThrow(/positive/);
    expect(() => normaliseShares(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`T${i}`, 1])))).toThrow(/1 to 50/);
  });

  it("derives drift and return from the broker numbers", () => {
    const pie = pieOverview({ id: 7, result: { priceAvgInvestedValue: 960, priceAvgValue: 1000 } }, detail, 7);
    expect(pie.name).toBe("Core");
    expect(pie.result).toBe(40);
    expect(pie.resultPercent).toBe(4.17);
    expect(pie.drift).toBe(0.05);
    expect(pie.instruments?.[1]).toMatchObject({ ticker: "EIMI_EQ", driftShare: -0.05, issues: [{ name: "DELISTED" }] });
  });
});

describe("pies service", () => {
  it("lists pies with totals and caches the rate-limited reads", async () => {
    const { pies, calls } = setup();
    const first = await pies.listPies("demo");
    expect(first.pies[0]).toMatchObject({ id: 7, name: "Core", value: 1000, status: "ON_TRACK", goal: 5000 });
    expect(first.totals).toEqual({ value: 1000, invested: 960, result: 40, cash: 12.5 });
    await pies.listPies("demo");
    expect(calls.filter((call) => call.path === "/equity/pies")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/equity/pies/7")).toHaveLength(1);
  });

  it("creates a pie only after confirmation, with resolved tickers and normalised shares", async () => {
    const { pies, calls } = setup();
    const preview = await pies.preparePieChange({ environment: "demo", action: "create", name: "Growth", instrumentShares: { VUSA: 60, EIMI: 40 } });
    expect(preview.request).toEqual({ name: "Growth", instrumentShares: { VUSA_EQ: 0.6, EIMI_EQ: 0.4 }, dividendCashAction: "REINVEST" });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const result = await pies.executePieChange(preview.token);
    expect(result).toMatchObject({ ok: true, status: "submitted" });
    expect(calls.find((call) => call.method === "POST")).toMatchObject({ path: "/equity/pies", body: { name: "Growth", instrumentShares: { VUSA_EQ: 0.6, EIMI_EQ: 0.4 } } });
    await expect(pies.executePieChange(preview.token)).rejects.toThrow(/invalid or expired/);
  });

  it("keeps unchanged settings on update and lists the slice changes", async () => {
    const { pies, calls } = setup();
    const preview = await pies.preparePieChange({ environment: "demo", action: "update", pieId: 7, instrumentShares: { VUSA: 50, EIMI: 30, AGGH: 20 } });
    expect(preview.request).toMatchObject({ name: "Core", icon: "Home", goal: 5000, dividendCashAction: "REINVEST" });
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes).toEqual(expect.arrayContaining([{ ticker: "VUSA_EQ", from: 0.7, to: 0.5 }, { ticker: "AGGH_EQ", from: 0, to: 0.2 }]));
    await pies.executePieChange(preview.token);
    expect(calls.find((call) => call.method === "POST")?.path).toBe("/equity/pies/7");
  });

  it("needs the second confirmation for Live and leaves the token usable without it", async () => {
    const { pies, calls } = setup();
    const preview = await pies.preparePieChange({ environment: "live", action: "delete", pieId: 7 });
    expect(preview.notices.join(" ")).toMatch(/holds about 1000/);
    await expect(pies.executePieChange(preview.token)).rejects.toThrow(/second confirmation/);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(await pies.executePieChange(preview.token, { liveAcknowledged: true })).toMatchObject({ ok: true });
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe("/equity/pies/7");
  });

  it("duplicates with a new name", async () => {
    const { pies, calls } = setup();
    const preview = await pies.preparePieChange({ environment: "demo", action: "duplicate", pieId: 7, name: "Core copy" });
    const result = await pies.executePieChange(preview.token);
    expect(result.pieId).toBe(8);
    expect(calls.find((call) => call.method === "POST")).toMatchObject({ path: "/equity/pies/7/duplicate", body: { name: "Core copy" } });
  });

  it("explains a missing pies permission", async () => {
    const { pies } = setup({ writeStatus: 403 });
    const preview = await pies.preparePieChange({ environment: "demo", action: "duplicate", pieId: 7 });
    expect(await pies.executePieChange(preview.token)).toMatchObject({ ok: false, status: "rejected", message: expect.stringMatching(/pies write permission/) });
  });

  it("reports an unknown pie", async () => {
    const { pies } = setup();
    await expect(pies.preparePieChange({ environment: "demo", action: "update", pieId: 99, name: "x" })).rejects.toMatchObject({ code: "PIE_NOT_FOUND" });
  });
});
