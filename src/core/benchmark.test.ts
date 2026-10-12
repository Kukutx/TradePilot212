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
    expect(compared.benchmarkTicker).toBe("VUSAl_EQ");
    expect(compared.benchmarkOptions?.map((option) => option.ticker)).toEqual(["VUSAl_EQ", "EUNLd_EQ"]);
    const text = describePayload({ ...summary(), ...compared });
    expect(text).toMatch(/^Benchmark VUSA \(Vanguard S&P 500 UCITS ETF \(Dist\)\) over the same days: [+-][\d.]+% \(simulated closes\), so the time-weighted return is [\d.]+ percentage points (ahead of|behind) it\. It is in GBX, so currency moves against EUR are not in it\.$/m);
  });

  it("compares with another fund when asked, or with none, still offering the choices", async () => {
    const services = sample();
    const world = await compareWithBenchmark(services, "demo", summary(), "EUNL");
    expect(world.benchmark).toMatchObject({ ticker: "EUNLd_EQ", currencyCode: "EUR" });
    const none = await compareWithBenchmark(services, "demo", summary(), "none");
    expect(none).toEqual({ benchmarkOptions: [expect.objectContaining({ ticker: "VUSAl_EQ" })] });
    // Nothing to compare without a time-weighted return.
    expect(await compareWithBenchmark(services, "demo", summary({ timeWeighted: undefined }))).toEqual({});
  });

  it("says why there is no comparison", async () => {
    const services = sample();
    expect(await compareWithBenchmark(services, "demo", summary(), "Not a fund at all")).toMatchObject({ benchmarkMissing: "symbol" });
    // A US symbol Trading 212 does not list is the sample's to refuse: it prices only its own instruments.
    expect(await compareWithBenchmark(services, "demo", summary(), "QQQ")).toMatchObject({ benchmarkTicker: "QQQ_US_EQ", benchmarkMissing: "sample" });
    const late = await compareWithBenchmark({ ...services, priceHistory: async () => ({ prices: { source: "stooq", symbol: "VUSA.UK", points: [{ date: "2026-09-20", close: 1 }, { date: "2026-10-09", close: 2 }] } }) }, "demo", summary());
    expect(late).toMatchObject({ benchmarkMissing: "data", benchmarkProblem: "stooq's closes for VUSA.UK start on 2026-09-20, after the first recorded day (2026-09-07)." });
    expect(describePayload({ ...summary(), ...late })).toMatch(/^No benchmark comparison: stooq's closes for VUSA\.UK start on 2026-09-20/m);
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
