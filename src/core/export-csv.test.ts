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
  const reports = [
    { reportId: 11, status: "Finished", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-04-01T00:00:00Z", downloadLink: "https://files.test/11.csv?sig=abc" },
    { reportId: 12, status: "Processing", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-10-30T09:00:00Z" },
  ];
  function broker() {
    const calls: Array<{ url: string; method: string; auth: boolean }> = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", auth: Boolean(new Headers(init?.headers).get("authorization")) });
      if (url.startsWith("https://files.test/")) return new Response(CSV, { status: 200 });
      if (url.endsWith("/equity/history/exports") && init?.method === "POST") return Response.json({ reportId: 13 });
      return Response.json(reports);
    }) as typeof fetch;
    return { calls, service: new InsightsService({ config, instruments: async () => [], fetcher }) };
  }

  it("reads the newest finished report from its link, without the API key, once", async () => {
    const { calls, service } = broker();
    const read = await service.readExport("demo");
    expect(read.report.reportId).toBe(11);
    expect(read.summary!.charges.find((charge) => charge.name === "Stamp duty reserve tax")!.totals).toEqual({ GBP: 1.25 });
    const download = calls.find((call) => call.url.startsWith("https://files.test/"))!;
    expect(download.auth).toBe(false);
    await service.readExport("demo", 11);
    expect(calls.filter((call) => call.url.startsWith("https://files.test/"))).toHaveLength(1);
    // Not finished: its status, nothing downloaded.
    expect(await service.readExport("demo", 12)).toEqual({ report: reports[1] });
    await expect(service.readExport("demo", 99)).rejects.toThrow(/no report 99/);
  });

  it("gives the report of the same period already asked for rather than request a second", async () => {
    const { calls, service } = broker();
    const again = await service.requestExport("demo", { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-10-30T15:00:00Z") });
    expect(again).toMatchObject({ reportId: 12, reused: { status: "Processing" } });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const other = await service.requestExport("demo", { from: new Date("2025-01-01T00:00:00Z"), to: new Date("2026-10-30T15:00:00Z") });
    expect(other).toEqual({ reportId: 13 });
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
