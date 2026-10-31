import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { parseCsv, summarizeExport } from "./export-csv.js";
import { InsightsService } from "./insights-service.js";
import { createSampleBroker, SAMPLE_BASE_URL } from "./sample-broker.js";
import { describePayload } from "./text-summary.js";

// The shape of Trading 212's export: columns only for what the period holds, amounts paired with a currency column.
const CSV = [
  "﻿Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Stamp duty reserve tax,Currency (Stamp duty reserve tax),Currency conversion fee,Currency (Currency conversion fee),French transaction tax,Currency (French transaction tax)",
  "Deposit,2026-01-02 09:00:00,,,,\"Bank transfer, ref 1\",D1,,,,,,,1000.00,EUR,,,,,,,,",
  "Market buy,2026-01-05 15:31:02,US0378331005,AAPL,\"Apple Inc.\",,EOF1,2.5,180.00,USD,1.08,,,417.26,EUR,,,,,0.62,EUR,,",
  "Market buy,2026-01-06 10:00:00,GB00B03MLX29,RDSA,\"Shell \"\"A\"\"\",,EOF2,10,25.00,GBP,0.85,,,295.59,EUR,,,1.25,GBP,0.44,EUR,,",
  "Limit buy,2026-01-07 10:00:00,FR0000121014,MC,LVMH,,EOF3,1,700.00,EUR,1,,,702.10,EUR,,,,,,,2.10,EUR",
  "Market sell,2026-02-01 15:40:00,US0378331005,AAPL,\"Apple Inc.\",,EOF4,1,200.00,USD,1.10,12.30,EUR,181.55,EUR,,,,,0.27,EUR,,",
  "Dividend (Ordinary),2026-02-15 08:00:00,US0378331005,AAPL,\"Apple Inc.\",,,1.5,0.25,USD,1.09,,,0.29,EUR,0.06,USD,,,,,,",
  "Interest on cash,2026-02-28 23:00:00,,,,,I1,,,,,,,1.84,EUR,,,,,,,,",
  "Interest on cash,2026-03-31 23:00:00,,,,,I2,,,,,,,2.01,EUR,,,,,,,,",
  "",
].join("\r\n");

describe("CSV export", () => {
  it("reads quoted fields, doubled quotes, CRLF and a byte-order mark", () => {
    const rows = parseCsv("a,b,c\r\n\"x, y\",\"say \"\"hi\"\"\",\r\n\n1,2,3");
    expect(rows).toEqual([["a", "b", "c"], ["x, y", "say \"hi\"", ""], ["1", "2", "3"]]);
    expect(parseCsv("﻿Action\nDeposit")[0]).toEqual(["Action"]);
  });

  it("adds up each action, the charges, interest, dividends and realised result per currency", () => {
    const { summary, records } = summarizeExport(CSV);
    expect(summary.rows).toBe(8);
    expect(summary.first).toBe("2026-01-02 09:00:00");
    expect(summary.last).toBe("2026-03-31 23:00:00");
    expect(summary.actions.slice(0, 2)).toEqual([
      { action: "Interest on cash", count: 2, totals: { EUR: 3.85 } },
      { action: "Market buy", count: 2, totals: { EUR: 712.85 } },
    ]);
    expect(summary.charges).toEqual([
      { name: "Withholding tax", totals: { USD: 0.06 } },
      { name: "Stamp duty reserve tax", totals: { GBP: 1.25 } },
      { name: "Currency conversion fee", totals: { EUR: 1.33 } },
      { name: "French transaction tax", totals: { EUR: 2.1 } },
    ]);
    expect(summary.interest).toEqual({ EUR: 3.85 });
    expect(summary.dividends).toEqual({ EUR: 0.29 });
    expect(summary.result).toEqual({ EUR: 12.3 });
    expect(records[2]).toMatchObject({ Name: "Shell \"A\"", "Stamp duty reserve tax": "1.25" });
    expect(records[0]!.Notes).toBe("Bank transfer, ref 1");
    expect(describePayload({ kind: "history_export", summary })).toContain("Currency conversion fee: 1.33 EUR");
  });

  it("works out the tax withheld from dividends by the country of each ISIN", () => {
    const csv = [
      "Action,Time,ISIN,Ticker,No. of shares,Price / share,Currency (Price / share),Total,Currency (Total),Withholding tax,Currency (Withholding tax)",
      "Dividend (Ordinary),2026-02-15 08:00:00,US0378331005,AAPL,10,0.25,USD,2.00,EUR,0.38,USD",
      "Dividend (Ordinary),2026-03-01 08:00:00,US1912161007,KO,20,0.50,USD,6.40,EUR,3.00,USD",
      "Dividend (Ordinary),2026-03-10 08:00:00,GB00B03MLX29,SHEL,100,25,GBX,25.00,EUR,,",
      "Dividend (Dividend),2026-03-20 08:00:00,IE00B3XXRP09,VUSA,10,0.30,USD,2.80,EUR,,",
      "Dividend (Ordinary),2026-03-25 08:00:00,NL0010273215,ASML,1,1.60,EUR,1.36,EUR,0.24,EUR",
      "Dividend (Ordinary),2026-03-26 08:00:00,DE0007164600,SAP,1,2.00,EUR,1.50,EUR,0.50,USD",
      "Market buy,2026-03-27 10:00:00,US0378331005,AAPL,1,200,USD,185,EUR,,",
    ].join("\n");
    const { summary } = summarizeExport(csv);
    expect(summary.withholding).toEqual([
      // US: 3.38 of 12.50, 27%: at or over 25%, so flagged.
      { country: "US", currency: "USD", payments: 2, gross: 12.5, withheld: 3.38, rate: 0.2704, tickers: ["AAPL", "KO"], high: true },
      { country: "NL", currency: "EUR", payments: 1, gross: 1.6, withheld: 0.24, rate: 0.15, tickers: ["ASML"] },
      // Pence counted as pounds; nothing withheld.
      { country: "GB", currency: "GBP", payments: 1, gross: 25, withheld: 0, rate: 0, tickers: ["SHEL"] },
      { country: "IE", currency: "USD", payments: 1, gross: 3, withheld: 0, rate: 0, tickers: ["VUSA"] },
    ]);
    const text = describePayload({ kind: "history_export", summary });
    expect(text).toContain("Withheld from dividends: US 27.04% (3.38 of 12.5 USD gross, 2 payments)");
    expect(text).toContain("W-8BEN");
    // No withholding column: nothing to say.
    expect(summarizeExport("Action,Time,Total,Currency (Total)\nDeposit,2026-01-01 10:00:00,5,EUR").summary.withholding).toBeUndefined();
  });

  it("reads an older file that puts the currency in the header", () => {
    const { summary } = summarizeExport("Action,Time,Total (EUR),Currency conversion fee (EUR)\nMarket buy,2025-01-01 10:00:00,100,0.15\nMarket buy,2025-01-02 10:00:00,50,0.08\n");
    expect(summary.actions).toEqual([{ action: "Market buy", count: 2, totals: { EUR: 150 } }]);
    expect(summary.charges).toEqual([{ name: "Currency conversion fee", totals: { EUR: 0.23 } }]);
  });
});

describe("CSV export reports", () => {
  const config = {
    trading212: {
      demo: { baseUrl: "https://demo.test/api/v0", apiKey: "key", apiSecret: "secret" },
      live: { baseUrl: "https://live.test/api/v0", apiKey: "", apiSecret: "" },
    },
  } as RuntimeConfig;
  const all = { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true };
  const reports = [
    { reportId: 11, status: "Finished", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-04-01T00:00:00Z", dataIncluded: all, downloadLink: "https://files.test/11.csv?sig=abc" },
    { reportId: 12, status: "Processing", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-10-30T09:00:00Z", dataIncluded: all },
    // Made in the app with orders alone: not a report of every kind of record.
    { reportId: 10, status: "Finished", timeFrom: "2025-01-01T00:00:00Z", timeTo: "2026-10-30T12:00:00Z", dataIncluded: { ...all, includeDividends: false }, downloadLink: "https://files.test/10.csv" },
  ];
  function broker(file = CSV) {
    const calls: Array<{ url: string; method: string; auth: boolean }> = [];
    let listing: number | undefined;
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", auth: Boolean(new Headers(init?.headers).get("authorization")) });
      if (url.startsWith("https://files.test/")) return new Response(file, { status: 200 });
      if (url.endsWith("/equity/history/exports") && init?.method === "POST") return Response.json({ reportId: 13 });
      return listing ? new Response("{}", { status: listing }) : Response.json(reports);
    }) as typeof fetch;
    return { calls, fail: (status: number) => { listing = status; }, service: new InsightsService({ config, instruments: async () => [], fetcher }) };
  }

  it("reads a finished report from its link, without the API key, once", async () => {
    const { calls, service } = broker();
    const read = await service.readExport("demo", 11);
    expect(read.summary!.charges.find((charge) => charge.name === "Stamp duty reserve tax")!.totals).toEqual({ GBP: 1.25 });
    // The newest rows first.
    expect(read.records![0]!.Time).toBe("2026-03-31 23:00:00");
    expect(read.recordCount).toBe(8);
    expect(calls.find((call) => call.url.startsWith("https://files.test/"))!.auth).toBe(false);
    // Read again: neither listed nor downloaded.
    const before = calls.length;
    await service.readExport("demo", 11);
    expect(calls.length).toBe(before);
    // The newest report is still being built: its status, not an older report of another period.
    expect(await service.readExport("demo")).toEqual({ report: reports[1] });
    await expect(service.readExport("demo", 99)).rejects.toThrow(/no report 99/);
  });

  it("follows a redirect only to https", async () => {
    const hops = (location: string) => (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith("https://files.test/11.csv")) return new Response(null, { status: 302, headers: { location } });
      if (url.startsWith("https://mirror.test/")) return new Response(CSV);
      return Response.json(reports);
    }) as typeof fetch;
    const moved = await new InsightsService({ config, instruments: async () => [], fetcher: hops("https://mirror.test/11.csv") }).readExport("demo", 11);
    expect(moved.recordCount).toBe(8);
    await expect(new InsightsService({ config, instruments: async () => [], fetcher: hops("http://169.254.169.254/latest") }).readExport("demo", 11)).rejects.toThrow(/not https/);
  });

  it("does not read a file larger than it reads", async () => {
    const { service } = broker("x".repeat(26_000_000));
    await expect(service.readExport("demo", 11)).rejects.toThrow(/larger than TradePilot reads/);
  });

  it("gives a report that holds the period rather than request a second, and requests none when it cannot tell", async () => {
    const { calls, service, fail } = broker();
    const within = await service.requestExport("demo", { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-10-30T08:30:00Z") });
    expect(within).toMatchObject({ reportId: 12, reused: { status: "Processing" } });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    // Ending later than any report (by more than an hour), or starting earlier: a new one. The orders-only report
    // is never given.
    expect(await service.requestExport("demo", { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-10-30T11:00:00Z") })).toEqual({ reportId: 13 });
    expect(await service.requestExport("demo", { from: new Date("2025-06-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") })).toEqual({ reportId: 13 });
    fail(429);
    const posts = calls.filter((call) => call.method === "POST").length;
    await expect(service.requestExport("demo", { from: new Date("2024-01-01T00:00:00Z"), to: new Date("2026-10-30T11:00:00Z") })).rejects.toThrow();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(posts);
  });

  it("does not count a card payment's charge amount as a charge", () => {
    const { summary } = summarizeExport("Action,Time,Total,Currency (Total),Charge amount,Currency (Charge amount),Exchange rate,Deposit fee,Currency (Deposit fee)\nCard debit,2026-01-01 10:00:00,-45,EUR,45,GBP,1.17,,\nDeposit,2026-01-02 10:00:00,100,EUR,,,,0.7,EUR\n");
    expect(summary.charges).toEqual([{ name: "Deposit fee", totals: { EUR: 0.7 } }]);
  });

  it("reads the sample account's report", async () => {
    const sample = { trading212: { demo: { baseUrl: SAMPLE_BASE_URL, apiKey: "sample", apiSecret: "sample" }, live: config.trading212.live } } as RuntimeConfig;
    const service = new InsightsService({ config: sample, instruments: async () => [], fetcher: createSampleBroker() });
    const read = await service.readExport("demo");
    expect(read.summary!.rows).toBeGreaterThan(20);
    expect(read.summary!.actions.map((action) => action.action)).toEqual(expect.arrayContaining(["Market buy", "Dividend (Ordinary)", "Deposit", "Interest on cash"]));
    expect(read.summary!.charges.map((charge) => charge.name)).toEqual(["Withholding tax", "Currency conversion fee"]);
    expect(read.summary!.interest).toEqual({ EUR: 6.4 });
  });
});
