import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import type { HistoryDividendItem, HistoryOrderItem } from "../shared/history.js";
import type { PricePoint } from "../shared/prices.js";
import { allTimeGains, attributeGains, closeBefore, holdingFlows, readAttribution, type StartClose } from "./attribution.js";
import type { PriceHistoryRequest } from "./price-history.js";

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const instrument = (ticker: string, currencyCode: string): Instrument => ({ ticker, name: ticker, shortName: ticker.split("_")[0]!, currencyCode });
const position = (ticker: string, currencyCode: string, quantity: number, currentPrice: number, currentValue: number, unrealizedProfitLoss?: number): Position => ({
  instrument: instrument(ticker, currencyCode), quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: 1, currentPrice,
  walletImpact: { currentValue, ...(unrealizedProfitLoss === undefined ? {} : { unrealizedProfitLoss }) },
});
const fill = (ticker: string, side: "BUY" | "SELL", quantity: number, price: number, day: string, netValue?: number, realisedProfitLoss?: number): HistoryOrderItem => ({
  order: { ticker, side, filledQuantity: quantity },
  fill: { filledAt: `${day}T15:00:00Z`, price, quantity: side === "SELL" ? -quantity : quantity, walletImpact: { ...(netValue === undefined ? {} : { netValue }), ...(realisedProfitLoss === undefined ? {} : { realisedProfitLoss }) } },
});
const dividend = (ticker: string, amount: number, day: string): HistoryDividendItem => ({ ticker, amount, quantity: 10, paidOn: `${day}T12:00:00Z` });

describe("gain attribution", () => {
  it("sums each instrument's fills and dividends in the period, in the account currency where Trading 212 gives it", () => {
    const flows = holdingFlows([
      fill("AAPL_US_EQ", "BUY", 2, 200, "2026-09-20", 368),
      fill("AAPL_US_EQ", "SELL", 1, 210, "2026-10-01", 193),
      // Before the period: part of what was held at its start.
      fill("AAPL_US_EQ", "BUY", 5, 150, "2026-08-01", 690),
      // No account amount: kept in the instrument's currency.
      fill("KO_US_EQ", "BUY", 4, 60, "2026-09-25"),
    ], [dividend("AAPL_US_EQ", 2.5, "2026-09-30"), dividend("AAPL_US_EQ", 2.5, "2026-06-30")], at("2026-09-12"), at("2026-10-12"));
    expect(flows.get("AAPL_US_EQ")).toMatchObject({ boughtQuantity: 2, soldQuantity: 1, bought: 368, sold: 193, dividends: 2.5, rated: { local: 610, account: 561 } });
    expect(flows.get("KO_US_EQ")).toMatchObject({ boughtQuantity: 4, bought: 0, boughtLocal: 240 });
  });

  it("values the start at the last close before it, and not at one more than ten days older", () => {
    const points: PricePoint[] = [{ date: "2026-09-09", close: 10 }, { date: "2026-09-11", close: 11 }, { date: "2026-09-12", close: 12 }];
    expect(closeBefore(points, "2026-09-12")).toEqual({ date: "2026-09-11", close: 11 });
    expect(closeBefore(points, "2026-09-25")).toBeUndefined();
    expect(closeBefore([], "2026-09-12")).toBeUndefined();
  });

  it("gives each instrument's gain from its value at the start, its trading and its dividends, largest first", () => {
    const from = at("2026-09-12");
    // A EUR account: USD at 1.1 a euro, pence at 85 a euro.
    const positions = [
      position("AAPL_US_EQ", "USD", 11, 220, 2200),
      position("VUSAl_EQ", "GBX", 40, 9000, 4235.29),
      position("NVDA_US_EQ", "USD", 5, 110, 500),
    ];
    const flows = holdingFlows([
      fill("AAPL_US_EQ", "BUY", 2, 200, "2026-09-20", 368),
      fill("AAPL_US_EQ", "SELL", 1, 210, "2026-10-01", 193),
      // Bought in the period: no close needed.
      fill("NVDA_US_EQ", "BUY", 5, 100, "2026-09-15", 460),
      // Held at the start and sold since, in a currency not held now: its own fills give the rate.
      fill("SHEL_EQ", "SELL", 10, 2800, "2026-09-30", 323.53),
    ], [dividend("AAPL_US_EQ", 2.5, "2026-09-30")], from, at("2026-10-12"));
    const closes = new Map<string, StartClose>([
      ["AAPL_US_EQ", { date: "2026-09-11", close: 190 }],
      ["VUSAl_EQ", { date: "2026-09-11", close: 8800 }],
      ["SHEL_EQ", { date: "2026-09-11", close: 2700 }],
    ]);
    const result = attributeGains({ from, to: at("2026-10-12"), positions, flows, closes, currencies: new Map([["SHEL_EQ", "GBP"]]), rates: { EUR: 1, USD: 1.1, GBX: 85 } });
    expect(result.from).toBe("2026-09-12");
    expect(result.basis).toBe("start");
    const aapl = result.holdings.find((holding) => holding.ticker === "AAPL_US_EQ")!;
    // 10 shares at the start: 11 now, 2 bought, 1 sold; 10 × 190 / 1.1 = 1727.27.
    expect(aapl).toEqual({ ticker: "AAPL_US_EQ", startQuantity: 10, quantity: 11, startClose: { date: "2026-09-11", price: 190 }, startValue: 1727.27, value: 2200, bought: 368, sold: 193, dividends: 2.5, gain: 300.23, return: 0.1433 });
    const vusa = result.holdings.find((holding) => holding.ticker === "VUSAl_EQ")!;
    expect(vusa).toMatchObject({ startQuantity: 40, startValue: 4141.18, gain: 94.11 });
    expect(result.holdings.find((holding) => holding.ticker === "NVDA_US_EQ")).toMatchObject({ startQuantity: 0, startValue: 0, gain: 40, return: 0.087 });
    // 10 × 2800 pence for 323.53 euros: 86.54 pence a euro, so 10 at 2700 was 311.98.
    expect(result.holdings.find((holding) => holding.ticker === "SHEL_EQ")).toMatchObject({ startQuantity: 10, quantity: 0, value: 0, sold: 323.53, startValue: 311.98, gain: 11.55 });
    expect(result.holdings.map((holding) => holding.ticker)).toEqual(["AAPL_US_EQ", "VUSAl_EQ", "NVDA_US_EQ", "SHEL_EQ"]);
    expect(result.total).toBe(445.89);
    expect(result.missing).toEqual([]);
  });

  it("lists what it cannot value: no close, shares that do not add up, no exchange rate", () => {
    const from = at("2026-09-12");
    const positions = [position("AAPL_US_EQ", "USD", 10, 220, 2000), position("MSFT_US_EQ", "USD", 2, 400, 727.27), position("SAP_EQ", "CHF", 3, 100, 320)];
    const flows = holdingFlows([fill("MSFT_US_EQ", "BUY", 5, 380, "2026-09-20", 1727)], [], from, at("2026-10-12"));
    const closes = new Map<string, StartClose>([["AAPL_US_EQ", { missing: "symbol", problem: "AAPL_US_EQ has no Stooq symbol." }], ["SAP_EQ", { date: "2026-09-11", close: 95 }]]);
    const result = attributeGains({ from, to: at("2026-10-12"), positions, flows, closes, currencies: new Map(), rates: { EUR: 1, USD: 1.1 } });
    expect(result.holdings).toEqual([]);
    expect(result.missing.map((item) => [item.ticker, item.reason])).toEqual([["AAPL_US_EQ", "symbol"], ["MSFT_US_EQ", "quantity"], ["SAP_EQ", "rate"]]);
    expect(result.total).toBe(0);
  });

  it("over all history, adds Trading 212's realised and unrealised P/L and the dividends", () => {
    const positions = [position("AAPL_US_EQ", "USD", 10, 220, 2000, 300), position("KO_US_EQ", "USD", 5, 60, 272.73)];
    const flows = holdingFlows([fill("AAPL_US_EQ", "SELL", 2, 200, "2026-03-01", 360, 40), fill("TSLA_US_EQ", "SELL", 1, 250, "2026-04-01", 227, -12)],
      [dividend("AAPL_US_EQ", 5, "2026-06-30")], undefined, at("2026-10-12"));
    const result = allTimeGains({ to: at("2026-10-12"), positions, flows });
    expect(result.basis).toBe("cost");
    expect(result.from).toBeUndefined();
    expect(result.holdings.map((holding) => [holding.ticker, holding.gain])).toEqual([["AAPL_US_EQ", 345], ["TSLA_US_EQ", -12]]);
    expect(result.missing.map((item) => [item.ticker, item.reason])).toEqual([["KO_US_EQ", "data"]]);
    expect(result.total).toBe(333);
  });

  it("reads the closes of what was held at the start, within a time budget, and says why when it cannot", async () => {
    const now = new Date("2026-10-12T10:00:00Z");
    const window = { from: new Date("2026-09-12T10:00:00Z"), to: now };
    const positions = [position("AAPL_US_EQ", "USD", 10, 220, 2000), position("NVDA_US_EQ", "USD", 5, 110, 500)];
    const orders = [fill("NVDA_US_EQ", "BUY", 5, 100, "2026-09-15", 460)];
    const asked: PriceHistoryRequest[] = [];
    let truncated: string | undefined;
    const deps = {
      config: { sampleData: false },
      trading: {
        getDashboard: async () => ({ account: { currency: "EUR" }, positions }) as never,
        instruments: async () => [],
        externalQuote: async () => undefined,
      },
      insights: {
        collect: async (_environment: unknown, kind: string) => ({ items: kind === "orders" ? orders : [], truncated: truncated === kind }) as never,
      },
      priceHistory: async (request: PriceHistoryRequest) => {
        asked.push(request);
        return { prices: { source: "stooq", points: [{ date: "2026-09-10", close: 180 }, { date: "2026-09-11", close: 190 }, { date: "2026-09-14", close: 200 }] } };
      },
    };
    const read = await readAttribution(deps, "demo", window, undefined, now);
    // Only AAPL was held at the start; its closes from a year back, as the holding page reads them, checked against its
    // price and its fills.
    expect(asked.map((request) => [request.instrument.ticker, request.from.toISOString(), request.last])).toEqual([["AAPL_US_EQ", "2025-10-12T00:00:00.000Z", 220]]);
    expect(await asked[0]!.fills).toEqual([]);
    expect(read.attribution?.holdings.map((holding) => [holding.ticker, holding.startValue, holding.gain])).toEqual([["AAPL_US_EQ", 1727.27, 272.73], ["NVDA_US_EQ", 0, 40]]);

    // Out of time: asked for next time.
    const late = await readAttribution({ ...deps, budgetMs: -1 }, "demo", window, undefined, now);
    expect(late.attribution?.missing).toEqual([{ ticker: "AAPL_US_EQ", reason: "later", problem: "AAPL_US_EQ's closes are asked for on the next read: this one ran out of time." }]);
    // A period that ended earlier, or a history cut short: no attribution, and why.
    expect(await readAttribution(deps, "demo", { from: window.from, to: new Date("2026-10-01T00:00:00Z") }, undefined, now)).toMatchObject({ attributionMissing: "period", attributionProblem: expect.stringMatching(/period that ends now/) });
    truncated = "orders";
    expect(await readAttribution(deps, "demo", window, undefined, now)).toMatchObject({ attributionMissing: "history", attributionProblem: expect.stringMatching(/order history stops at the page limit/) });
    // Dividends cut short would leave some out.
    truncated = "dividends";
    expect(await readAttribution(deps, "demo", window, undefined, now)).toMatchObject({ attributionMissing: "history", attributionProblem: expect.stringMatching(/dividend history stops/) });
    // The summary's own read of the history is used when it is handed over.
    const handed = await readAttribution({ ...deps, history: { orders: { items: orders, truncated: false }, dividends: { items: [dividend("NVDA_US_EQ", 3, "2026-10-01")], truncated: false } } }, "demo", window, undefined, now);
    expect(handed.attribution?.holdings.find((holding) => holding.ticker === "NVDA_US_EQ")).toMatchObject({ dividends: 3, gain: 43 });

    // A year back reaches 11 days before a 12-month period's first day; the sample account draws through its own anchors.
    asked.length = 0;
    truncated = undefined;
    await readAttribution({ ...deps, config: { sampleData: true } }, "demo", { from: new Date("2025-10-12T10:00:00Z"), to: now }, undefined, now);
    expect(asked.map((request) => [request.from.toISOString(), "fills" in request])).toEqual([["2025-10-01T00:00:00.000Z", false]]);
  });
});
