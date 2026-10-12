import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import type { Instrument, Position } from "../shared/contracts.js";
import type { HoldingWeight } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import { createConfig } from "./config.js";
import { readHoldingRisk } from "./holding-risk.js";
import type { PriceHistoryRequest, PriceHistoryResult } from "./price-history.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z");

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return { config, ...createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch }) };
}

const instrument = (ticker: string): Instrument => ({ ticker, name: ticker, shortName: ticker, currencyCode: "USD" });
const holding = (ticker: string, value: number): HoldingWeight => ({ ticker, name: ticker, currency: "USD", value, weight: 0 });
const position = (ticker: string): Position => ({ instrument: instrument(ticker), quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 1, currentPrice: 42 });

/** A year of Friday closes to 9 October 2026, moving by a pattern that differs with `seed`. */
function fridays(seed: number): PricePoint[] {
  const last = Date.UTC(2026, 9, 9);
  let close = 100;
  return Array.from({ length: 53 }, (_, index) => {
    close *= Math.exp(0.02 * Math.sin(index * (seed + 1)));
    return { date: new Date(last - (52 - index) * 7 * DAY_MS).toISOString().slice(0, 10), close };
  });
}

describe("reading risk by holding", () => {
  it("measures the sample account's holdings from a year of their closes", async () => {
    const services = sample();
    let read: { positions: Position[]; instruments: Instrument[] } | undefined;
    const analysis = await services.insights.allocation("demo", undefined, (positions) => { read = positions; });
    const result = await readHoldingRisk({ priceHistory: services.priceHistory }, "demo", analysis.holdings, read!);
    expect(result.riskProblem).toBeUndefined();
    expect(result.riskMissing).toBeUndefined();
    const risk = result.risk!;
    expect(risk.rows.map((row) => row.ticker).sort()).toEqual(analysis.holdings.filter((item) => item.value > 0).map((item) => item.ticker).sort());
    expect(risk.weeks).toBeGreaterThan(26);
    expect(risk.covered).toBe(1);
    expect(risk.rows.reduce((sum, row) => sum + row.risk, 0)).toBeCloseTo(1, 4);
    // The sample closes share a market factor, so the holdings move together, but not as one.
    expect(risk.diversification).toBeGreaterThan(1);
    expect(risk.rows.every((row) => row.correlation > 0 && row.correlation < 1)).toBe(true);
  });

  it("reads the largest holdings first, a few at a time, and leaves the rest for the next read once out of time", async () => {
    const tickers = ["A", "B", "C", "D", "E", "F"];
    const asked: string[] = [];
    const requests: PriceHistoryRequest[] = [];
    const priceHistory = async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => {
      asked.push(request.instrument.ticker);
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { prices: { source: "test", points: fridays(tickers.indexOf(request.instrument.ticker)) } };
    };
    // Listed by value from smallest: they are read from the largest.
    const holdings = tickers.map((ticker, index) => holding(ticker, 100 * (index + 1)));
    const result = await readHoldingRisk({ priceHistory, budgetMs: 20 }, "demo", holdings, { positions: tickers.map(position), instruments: [] }, NOW);
    expect(asked).toEqual(["F", "E", "D", "C"]);
    expect(result.riskMissing?.map((item) => [item.ticker, item.reason])).toEqual([["B", "later"], ["A", "later"]]);
    expect(result.risk?.rows.map((row) => row.ticker).sort()).toEqual(["C", "D", "E", "F"]);
    // C to F are 1800 of the 2100.
    expect(result.risk?.covered).toBeCloseTo(1800 / 2100, 4);
    // A year back from the start of the day, with the holding's last price to check the unit against.
    expect(requests[0]!.from.toISOString()).toBe("2025-10-10T00:00:00.000Z");
    expect(requests[0]!.last).toBe(42);
  });

  it("names the holdings it could not read, and why", async () => {
    const priceHistory = async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => {
      if (request.instrument.ticker === "NOSYM") return { missing: "symbol", problem: "No symbol for NOSYM." };
      if (request.instrument.ticker === "BROKEN") throw new Error("The provider is down.");
      return { prices: { source: "test", points: fridays(request.instrument.ticker.length) } };
    };
    const holdings = [holding("AAA", 500), holding("NOSYM", 400), holding("BROKEN", 300), holding("GONE", 200)];
    const result = await readHoldingRisk({ priceHistory }, "demo", holdings, { positions: [], instruments: ["AAA", "NOSYM", "BROKEN"].map(instrument) }, NOW);
    expect(result.risk).toBeUndefined();
    expect(result.riskProblem).toBe("Fewer than two holdings have daily closes to measure.");
    expect(result.riskMissing).toEqual([
      { ticker: "NOSYM", reason: "symbol", problem: "No symbol for NOSYM." },
      { ticker: "BROKEN", reason: "data", problem: "The provider is down." },
      { ticker: "GONE", reason: "data", problem: "Trading 212 does not list GONE at the moment." },
    ]);
  });

  it("says why there is nothing to measure", async () => {
    const priceHistory = async (): Promise<PriceHistoryResult> => ({ prices: { source: "test", points: fridays(1).slice(-10) } });
    const read = { positions: [], instruments: ["A", "B"].map(instrument) };
    expect(await readHoldingRisk({ priceHistory }, "demo", [holding("A", 100), holding("B", 0)], read, NOW)).toEqual({ riskProblem: "Risk by holding needs two holdings or more." });
    expect((await readHoldingRisk({}, "demo", [holding("A", 100), holding("B", 100)], read, NOW)).riskProblem).toMatch(/QUOTE_PROVIDER/);
    expect((await readHoldingRisk({ priceHistory }, "demo", [holding("A", 100), holding("B", 100)], read, NOW)).riskProblem).toMatch(/too few weeks of closes in common \(more than 26/);
  });
});

describe("the allocation tool's risk by holding", () => {
  it("says in the text why there is none, and what it left out", async () => {
    const analysis = await sample().insights.allocation("demo");
    const text = describePayload({ ...analysis, riskProblem: "Fewer than two holdings have daily closes to measure.", riskMissing: [{ ticker: "KO_US_EQ", reason: "symbol", problem: "No symbol for KO." }] });
    expect(text).toContain("No risk by holding: Fewer than two holdings have daily closes to measure.");
    expect(text).toContain("Risk by holding leaves out KO_US_EQ (No symbol for KO).");
  });

  it("adds the holdings' risk to the allocation and its text", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { createMcpServer } = await import("./mcp.js");
    const services = sample();
    const server = createMcpServer(services, services.config, async () => "<html></html>", new Set(["trade:read"]));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const outcome = await client.callTool({ name: "analyze_portfolio_allocation", arguments: { environment: "demo" } });
    const data = outcome.structuredContent as { risk?: { rows: Array<{ ticker: string; risk: number }>; correlations: { tickers: string[] } } };
    expect(data.risk?.rows.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(outcome.content);
    expect(text).toMatch(/the holdings' volatility together [\d.]+% a year, \w+_\w+ the largest share of it \(\d+%\)/);
    expect(text).toMatch(/Risk by holding \(weekly closes \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}, \d+ weeks, each in its own currency; 100% of the holdings' value\)/);
    expect(text).toMatch(/: \d+% of the risk, \d+% of the value; volatility \d+% a year, correlation with them together 0\.\d\d/);
    expect(text).toMatch(/Most alike: [^;]+; least alike: /);
    await client.close();
  });
});
