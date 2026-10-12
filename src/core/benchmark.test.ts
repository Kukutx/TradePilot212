import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import type { PerformanceSummary } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import { benchmarkReturns, compareWithBenchmark } from "./benchmark.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample(env: Record<string, string> = {}) {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", ...env });
  return { config, ...createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch }) };
}

const series = [
  { date: "2026-09-07", return: 0 },
  { date: "2026-09-12", return: 0.01 },
  { date: "2026-09-14", return: 0.03 },
  { date: "2026-10-12", return: 0.05 },
];

function summary(over: Partial<PerformanceSummary> = {}): PerformanceSummary {
  return {
    kind: "performance", environment: "demo", accountCurrency: "EUR", period: { to: "2026-10-12T12:00:00Z" },
    coverage: { orders: 0, dividends: 0, transactions: 0, truncated: false },
    contributions: { deposits: 0, withdrawals: 0, net: 0 }, income: { dividends: 0, interest: 0 }, costs: { total: 0, byType: [] },
    realizedProfitLoss: 0, trades: { buys: 0, sells: 0, turnover: 0 }, byTicker: [], notes: [], timestamp: "2026-10-12T12:00:00Z",
    timeWeighted: { return: 0.05, from: "2026-09-07", to: "2026-10-12", netFlows: 0, series },
    ...over,
  };
}

describe("benchmark returns", () => {
  it("takes each day's close on or before it, against the close on or before the first day", () => {
    const points: PricePoint[] = [
      { date: "2026-09-04", close: 100 },
      { date: "2026-09-11", close: 102 },
      { date: "2026-09-14", close: 99 },
      { date: "2026-10-09", close: 110 },
    ];
    // 7 September has no close: the Friday before stands in, and the Saturday takes Friday's.
    expect(benchmarkReturns(series, points)).toEqual({
      return: 0.1,
      series: [{ date: "2026-09-07", return: 0 }, { date: "2026-09-12", return: 0.02 }, { date: "2026-09-14", return: -0.01 }, { date: "2026-10-12", return: 0.1 }],
      // 99 against the high of 102: 2.9% down, back above it by 12 October.
      drawdown: { max: -0.029412, peak: "2026-09-12", trough: "2026-09-14", recovered: "2026-10-12", current: 0 },
    });
  });

  it("gives none when the closes start after the first day, or more than a week before it with nothing between", () => {
    expect(benchmarkReturns(series, [{ date: "2026-09-08", close: 100 }, { date: "2026-10-09", close: 110 }])).toBeUndefined();
    expect(benchmarkReturns(series, [{ date: "2026-08-20", close: 100 }])).toBeUndefined();
    expect(benchmarkReturns(series.slice(0, 1), [{ date: "2026-09-07", close: 100 }])).toBeUndefined();
  });
});

describe("compare with a benchmark", () => {
  it("compares the sample account with its S&P 500 fund, and offers its ETFs held and watched", async () => {
    const services = sample();
    await services.watchlist.add("demo", "EUNL");
    const compared = await compareWithBenchmark(services, "demo", summary());
    expect(compared.benchmark).toMatchObject({ ticker: "VUSAl_EQ", shortName: "VUSA", currencyCode: "GBX", source: "sample" });
    expect(compared.benchmark!.series.map((point) => point.date)).toEqual(series.map((point) => point.date));
    expect(compared.benchmark!.series[0]!.return).toBe(0);
    expect(compared.benchmarkChoice).toBe("VUSAl_EQ");
    expect(compared.benchmarkOptions?.map((option) => option.ticker)).toEqual(["VUSAl_EQ", "EUNLd_EQ"]);
    const text = describePayload({ ...summary(), ...compared });
    expect(text).toMatch(/^Benchmark VUSA \(Vanguard S&P 500 UCITS ETF \(Dist\)\) over the same days: [+-][\d.]+% \(simulated closes\), so the time-weighted return is [\d.]+ percentage points (ahead of|behind) it\. It is in GBX, so currency moves against EUR are not in it\.$/m);
  });

  it("compares with another fund when asked, or with none, still offering the choices", async () => {
    const services = sample();
    const world = await compareWithBenchmark(services, "demo", summary(), "EUNL");
    expect(world.benchmark).toMatchObject({ ticker: "EUNLd_EQ", currencyCode: "EUR" });
    const none = await compareWithBenchmark(services, "demo", summary(), "none");
    expect(none).toEqual({ benchmarkChoice: "none", benchmarkOptions: [expect.objectContaining({ ticker: "VUSAl_EQ" })] });
    // Nothing to compare without a time-weighted return.
    expect(await compareWithBenchmark(services, "demo", summary({ timeWeighted: undefined }))).toEqual({});
  });

  it("says why there is no comparison", async () => {
    const services = sample();
    expect(await compareWithBenchmark(services, "demo", summary(), "Not a fund at all")).toMatchObject({
      benchmarkChoice: "Not a fund at all", benchmarkMissing: "instrument", benchmarkProblem: "No Trading 212 instrument matched Not a fund at all",
    });
    // A US symbol Trading 212 does not list is the sample's to refuse: it prices only its own instruments.
    expect(await compareWithBenchmark(services, "demo", summary(), "QQQ")).toMatchObject({ benchmarkChoice: "QQQ_US_EQ", benchmarkMissing: "sample" });
    const late = await compareWithBenchmark({ ...services, priceHistory: async () => ({ prices: { source: "stooq", symbol: "VUSA.UK", points: [{ date: "2026-09-20", close: 1 }, { date: "2026-10-09", close: 2 }] } }) }, "demo", summary());
    expect(late).toMatchObject({ benchmarkMissing: "data", benchmarkProblem: "stooq's closes for VUSA.UK start on 2026-09-20, after the first recorded day (2026-09-07)." });
    expect(describePayload({ ...summary(), ...late })).toMatch(/^No benchmark comparison: stooq's closes for VUSA\.UK start on 2026-09-20/m);
  });

  it("names the listings of a fund Trading 212 lists twice rather than taking it for a US one", async () => {
    const services = sample();
    const listings = [
      { ticker: "VWRLl_EQ", name: "Vanguard FTSE All-World (Dist)", shortName: "VWRL", currencyCode: "GBX", type: "ETF" },
      { ticker: "VWRLa_EQ", name: "Vanguard FTSE All-World (Dist)", shortName: "VWRL", currencyCode: "EUR", type: "ETF" },
    ];
    let read = false;
    const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, { instruments: async () => listings });
    const compared = await compareWithBenchmark({ ...services, trading, priceHistory: async () => { read = true; return { missing: "data", problem: "" }; } }, "demo", summary(), "VWRL");
    expect(compared).toMatchObject({ benchmarkChoice: "VWRL", benchmarkMissing: "instrument" });
    expect(compared.benchmarkProblem).toContain("VWRLl_EQ, VWRLa_EQ");
    expect(read).toBe(false);
  });

  it("asks Trading 212 for nothing without a comparison, and only a US ticker without the instrument list", async () => {
    const services = sample();
    const asked: string[] = [];
    const trading = Object.assign(Object.create(Object.getPrototypeOf(services.trading)), services.trading, {
      instruments: async () => { asked.push("instruments"); throw new Error("429"); },
      positions: async () => { asked.push("positions"); return []; },
      cachedInstruments: () => undefined,
    });
    const priceHistory = async () => ({ prices: { source: "stooq", symbol: "X", points: [{ date: "2026-09-04", close: 1 }, { date: "2026-10-09", close: 1.1 }] } });
    expect(await compareWithBenchmark({ ...services, trading, priceHistory }, "demo", summary(), "none")).toEqual({ benchmarkChoice: "none" });
    expect(asked).toEqual([]);
    const spy = await compareWithBenchmark({ ...services, trading, priceHistory }, "demo", summary(), "SPY_US_EQ");
    expect(spy.benchmark).toMatchObject({ ticker: "SPY_US_EQ", return: 0.1 });
    const vusa = await compareWithBenchmark({ ...services, trading, priceHistory }, "demo", summary(), "VUSAl_EQ");
    expect(vusa).toMatchObject({ benchmarkMissing: "instrument", benchmarkProblem: "Trading 212's instrument list could not be read, so VUSAl_EQ could not be looked up; try again." });
  });

  it("reads a year of closes at least, so every period up to a year shares one read", async () => {
    const services = sample();
    const starts: string[] = [];
    const priceHistory = async ({ from }: { from: Date }) => {
      starts.push(from.toISOString().slice(0, 10));
      return { prices: { source: "stooq", symbol: "SPY.US", points: [{ date: "2025-09-01", close: 1 }, { date: "2026-10-09", close: 1.1 }] } };
    };
    const now = new Date("2026-10-12T15:00:00Z");
    await compareWithBenchmark({ ...services, priceHistory }, "demo", summary(), undefined, now);
    await compareWithBenchmark({ ...services, priceHistory }, "demo", summary({ timeWeighted: { ...summary().timeWeighted!, from: "2026-01-02", series: [{ date: "2026-01-02", return: 0 }, ...series] } }), undefined, now);
    await compareWithBenchmark({ ...services, priceHistory }, "demo", summary({ timeWeighted: { ...summary().timeWeighted!, from: "2024-05-01", series: [{ date: "2024-05-01", return: 0 }, ...series] } }), undefined, now);
    expect(starts).toEqual(["2025-10-12", "2025-10-12", "2024-04-24"]);
  });

  it("calls a fund in pence the account's currency for a GBP account, and a gap under 0.05 points level", async () => {
    const benchmark = { ticker: "VUSAl_EQ", shortName: "VUSA", currencyCode: "GBX", source: "stooq", return: 0.0502, series: [] };
    const text = describePayload({ ...summary({ accountCurrency: "GBP" }), benchmark });
    expect(text).toMatch(/^Benchmark VUSA over the same days: \+5% \(stooq closes\), so the time-weighted return is level with it\.$/m);
  });

  it("compares a real account with SPY by default, a US fund Trading 212 need not list", async () => {
    const services = sample();
    let asked: string | undefined;
    const compared = await compareWithBenchmark({
      ...services,
      config: { ...services.config, sampleData: false, benchmark: createConfig({}).benchmark },
      priceHistory: async ({ instrument }) => {
        asked = instrument.ticker;
        return { prices: { source: "stooq", symbol: "SPY.US", points: [{ date: "2026-09-04", close: 500 }, { date: "2026-10-09", close: 525 }] } };
      },
    }, "demo", summary());
    expect(asked).toBe("SPY_US_EQ");
    expect(compared.benchmark).toMatchObject({ ticker: "SPY_US_EQ", name: "SPDR S&P 500 ETF", shortName: "SPY", currencyCode: "USD", source: "stooq", return: 0.05 });
    expect(createConfig({ BENCHMARK: "none" }).benchmark).toBe("");
    expect(createConfig({ BENCHMARK: "VWRL" }).benchmark).toBe("VWRL");
  });
});
