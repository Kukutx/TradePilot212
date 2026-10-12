import { describe, expect, it, vi } from "vitest";
import { createServices } from "../app/services.js";
import type { Instrument, Position } from "../shared/contracts.js";
import type { HoldingWeight } from "../shared/history.js";
import { MAX_PARITY_TARGETS } from "../shared/holding-risk.js";
import type { PricePoint } from "../shared/prices.js";
import { createConfig } from "./config.js";
import { readHoldingRisk } from "./holding-risk.js";
import type { PriceHistoryRequest, PriceHistoryResult } from "./price-history.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";
import { MAX_BASKET_LEGS } from "./trading-service.js";

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

  it("reads the largest holdings first, a few at a time, waits a few seconds at most, and reads the rest on for the next read", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const tickers = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
      const asked: string[] = [];
      const requests: PriceHistoryRequest[] = [];
      // The four largest answer in a second, the next four in ten (still running when the reads stop waiting).
      const priceHistory = async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => {
        const ticker = request.instrument.ticker;
        asked.push(ticker);
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, "JIHG".includes(ticker) ? 1000 : 10_000));
        return { prices: { source: "test", points: fridays(tickers.indexOf(ticker)) } };
      };
      // Listed from the smallest: they are read from the largest.
      const holdings = tickers.map((ticker, index) => holding(ticker, 100 * (index + 1)));
      const pending = readHoldingRisk({ priceHistory }, "demo", holdings, { positions: tickers.map(position), instruments: [] }, NOW);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(asked.slice(0, 8)).toEqual(["J", "I", "H", "G", "F", "E", "D", "C"]);
      expect(result.risk?.rows.map((row) => row.ticker).sort()).toEqual(["G", "H", "I", "J"]);
      expect(result.riskMissing?.map((item) => [item.ticker, item.reason])).toEqual(["F", "E", "D", "C", "B", "A"].map((ticker) => [ticker, "later"]));
      // G to J are 3400 of the 5500.
      expect(result.risk?.covered).toBeCloseTo(3400 / 5500, 4);
      // B and A were not reached: they are asked now, without waiting, so the next read finds them cached.
      expect(asked.slice(8).sort()).toEqual(["A", "B"]);
      // A year back from the start of the day, with the holding's last price to check the unit against.
      expect(requests[0]).toMatchObject({ last: 42, minDays: 196 });
      expect(requests[0]!.from.toISOString()).toBe("2025-10-10T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a read the price history gave up waiting for as one for the next read", async () => {
    const priceHistory = async (request: PriceHistoryRequest): Promise<PriceHistoryResult> => request.instrument.ticker === "SLOW"
      ? { missing: "data", late: true, problem: "Stooq took more than 3 seconds." }
      : { prices: { source: "test", points: fridays(request.instrument.ticker.length) } };
    const result = await readHoldingRisk({ priceHistory }, "demo", [holding("A", 300), holding("BB", 200), holding("SLOW", 100)], { positions: [], instruments: ["A", "BB", "SLOW"].map(instrument) }, NOW);
    expect(result.riskMissing).toEqual([{ ticker: "SLOW", reason: "later", problem: "SLOW's closes were not read in time; they are read now for the next read." }]);
    expect(result.risk?.rows).toHaveLength(2);
  });

  it("says once when the quote provider gives no year of closes", async () => {
    const priceHistory = async (): Promise<PriceHistoryResult> => ({ missing: "plan", problem: "The alphavantage free plan's daily prices reach about 145 days back, and this needs 196." });
    const result = await readHoldingRisk({ priceHistory }, "demo", [holding("A", 300), holding("B", 200)], { positions: [], instruments: ["A", "B"].map(instrument) }, NOW);
    expect(result).toEqual({ riskProblem: "It needs a year of daily closes from the quote provider. The alphavantage free plan's daily prices reach about 145 days back, and this needs 196." });
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
    // Several for one reason are named together; three holdings' pairs are listed once.
    const risk = {
      from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.16, diversification: 1.3, covered: 0.8,
      rows: [{ ticker: "A", weight: 0.5, volatility: 0.2, risk: 0.6, correlation: 0.9 }, { ticker: "B", weight: 0.3, volatility: 0.2, risk: 0.3, correlation: 0.8 }, { ticker: "C", weight: 0.2, volatility: 0.1, risk: 0.1, correlation: 0.4 }],
      correlations: { tickers: ["A", "B", "C"], matrix: [[1, 0.6, 0.1], [0.6, 1, 0.3], [0.1, 0.3, 1]] },
      jumps: ["GBX"],
      mix: {
        value: 8000, return: 0.12, up: 30, counted: 52, badWeek: -0.034, badWeeks: -0.041,
        series: [{ date: "2025-10-10", return: 0 }, { date: "2026-10-09", return: 0.12 }],
        worst: { date: "2026-04-03", return: -0.052 }, best: { date: "2025-11-14", return: 0.044 },
        drawdown: { max: -0.098, peak: "2026-02-13", trough: "2026-04-03", current: -0.01, currentPeak: "2026-09-25" },
      },
    };
    const later = (ticker: string) => ({ ticker, reason: "later" as const, problem: `${ticker} later.` });
    const grouped = describePayload({ ...analysis, risk, riskMissing: [later("D"), later("E"), { ticker: "F", reason: "unit", problem: "Another unit." }] });
    expect(grouped).toContain("Correlations, most alike first: A–B 0.6, B–C 0.3, A–C 0.1.");
    expect(grouped).not.toContain("least alike");
    expect(grouped).toContain("Left out, closes that jump more than fivefold in a week (a change of unit or a split): GBX.");
    expect(grouped).toContain("Risk by holding leaves out D, E (not read in time; they are being read for the next read); F (Another unit).");
    // A mix that fell in fewer than one week in 20 has no bad week to put a figure on.
    const calm = describePayload({ ...analysis, risk: { ...risk, mix: { ...risk.mix, badWeek: 0.0019 } } });
    expect(calm).toContain("up in 30 of 52 weeks. It fell in fewer than one week in 20 (that week +0.2%). Worst week");
    expect(calm).not.toContain("A bad week");
    expect(grouped).toContain("Today's mix over those weeks, at today's weights kept each week, each holding in its own currency: +12%, up in 30 of 52 weeks. A bad week, one in 20: -3.4% or worse, about 272 EUR of today's 8000 EUR measured; -4.1% on average in those weeks. Worst week -5.2% to 2026-04-03, best +4.4% to 2025-11-14. Deepest fall -9.8%, from 2026-02-13 to 2026-04-03, not made up yet.");
    // No equal-risk weights before 2.48, or when none were found.
    expect(grouped).not.toContain("Equal-risk weights");
  });

  it("gives the equal-risk weights and the targets that plan the move", async () => {
    const analysis = await sample().insights.allocation("demo");
    const [a, b] = analysis.holdings;
    const measured = a!.value + b!.value;
    const risk = {
      from: "2025-10-10", to: "2026-10-09", weeks: 52, volatility: 0.16, diversification: 1.3, covered: 0.8, parityVolatility: 0.131,
      rows: [{ ticker: a!.ticker, weight: a!.value / measured, volatility: 0.3, risk: 0.8, correlation: 0.9, parity: 0.4 }, { ticker: b!.ticker, weight: b!.value / measured, volatility: 0.2, risk: 0.2, correlation: 0.5, parity: 0.6 }],
      correlations: { tickers: [a!.ticker, b!.ticker], matrix: [[1, 0.5], [0.5, 1]] },
    };
    const text = describePayload({ ...analysis, risk });
    expect(text).toContain("a holding that moved less than 2% a year keeps its weight): together 13.1% a year against 16% at today's weights. Furthest from it first: ");
    expect(text).toContain(`${b!.ticker} 60% (now ${Number((b!.value / measured * 100).toFixed(1))}%)`);
    expect(text).toContain("They spread the risk by the past year; they are not a forecast.");
    const target = (share: number) => String(Math.floor(share * measured / analysis.totalValue * 1e6) / 1e6);
    expect(text).toMatch(new RegExp(`To plan the move, call plan_portfolio_rebalance with targets (${a!.ticker} ${target(0.4)}, ${b!.ticker} ${target(0.6)}|${b!.ticker} ${target(0.6)}, ${a!.ticker} ${target(0.4)}) and cashWeight 0\\.\\d+: shares of the account`));
    expect(text).not.toContain("furthest from their equal-risk weight move");
    // The plan never has more targets than the planner's basket takes.
    expect(MAX_PARITY_TARGETS).toBe(MAX_BASKET_LEGS);
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
    expect(text).toMatch(/a bad week one in 20 -\d+\.\d%/);
    expect(text).toMatch(/Today's mix over those weeks, at today's weights kept each week, each holding in its own currency: [+-][\d.]+%, up in \d+ of \d+ weeks\. A bad week, one in 20: -[\d.]+% or worse, about [\d.]+ EUR of today's [\d.]+ EUR measured/);
    expect(text).toMatch(/Equal-risk weights, at which each holding measured brings the same share of their risk .*: together [\d.]+% a year against [\d.]+% at today's weights/);
    expect(text).toMatch(/To plan the move, call plan_portfolio_rebalance with targets \w+_\w+ 0\.\d+/);
    await client.close();
  });
});
