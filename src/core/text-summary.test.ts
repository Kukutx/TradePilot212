import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { readAttribution } from "./attribution.js";
import { createConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";

function sample() {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  return createServices({ config, store: new MemoryStateStore(), fetcher: (async () => new Response("{}")) as typeof fetch });
}

describe("text summaries for hosts that only show text", () => {
  it("lists the account and every holding", async () => {
    const services = sample();
    const dashboard = await services.trading.getDashboard("demo");
    const text = describePayload(dashboard);
    expect(text).toMatch(/EUR/);
    for (const position of dashboard.positions.slice(0, 5)) expect(text).toContain(position.instrument.ticker);
    // The sample stop-loss on NVIDIA sits below its last price; the Tesla buy limit has no last price.
    expect(text).toMatch(/#81235 SELL 5 NVDA_US_EQ \(NVIDIA\) stop 118, [\d.]+% below the last price [\d.]+/);
    expect(text).toMatch(/#81234 BUY 3 TSLA_US_EQ limit 215 GOOD_TILL_CANCEL \(NEW\)$/m);
  });

  it("gives an order preview's amount in the account currency and says when the token may be used", async () => {
    const services = sample();
    const preview = await services.trading.prepareOrder({ environment: "demo", ticker: "AAPL", side: "buy", type: "limit", quantity: 1, limitPrice: 200, timeValidity: "DAY" });
    const text = describePayload(preview);
    expect(text).toMatch(/Ready to send to DEMO: buy 1 AAPL_US_EQ/i);
    expect(text).toMatch(/\(about [\d.,]+ EUR\)/);
    expect(text).toContain(`Confirmation token ${preview.token}`);
    expect(text).toMatch(/only after the user explicitly says to/);
  });

  it("describes orders placed by amount and the quantity cap", async () => {
    const services = sample();
    const dashboard = await services.trading.getDashboard("demo");
    const text = describePayload({ ...dashboard, orders: [{ id: 7, ticker: "VUSA_EQ", strategy: "VALUE", value: 250, currency: "EUR", type: "MARKET", status: "NEW" }] });
    expect(text).toContain("#7 BUY value 250 EUR of VUSA_EQ market (NEW)");
    const config = createConfig({ MAX_ORDER_QUANTITY: "50" });
    const policy = describePayload({ kind: "trading_policy", environment: "demo", policy: config.policy.demo, maxOrderNotional: config.maxOrderNotional, maxOrderQuantity: config.maxOrderQuantity, usageToday: { orders: 0, notional: 0 } });
    expect(policy).toContain("quantity 50 shares");
  });

  it("gives the money-weighted yearly return and keeps tickers as Trading 212 spells them", async () => {
    const services = sample();
    const performance = await services.insights.performance("demo", { to: new Date() });
    expect(performance.annualizedReturn).toBeTypeOf("number");
    expect(performance.byTicker.map((item) => item.ticker)).toContain("VUSAl_EQ");
    expect(describePayload(performance)).toMatch(/Annualized return \(money-weighted, since \d{4}-\d{2}-\d{2}\) [+-]?\d/);
  });

  it("says each instrument's gain over the period and the ones it could not value", async () => {
    const services = sample();
    const window = { from: new Date(Date.now() - 365 * 86_400_000), to: new Date() };
    const performance = await services.insights.performance("demo", window);
    const attributed = await readAttribution({ config: { sampleData: true }, trading: services.trading, insights: services.insights, priceHistory: services.priceHistory }, "demo", window);
    const text = describePayload({ ...performance, ...attributed });
    expect(text).toMatch(/Gain by instrument since the close before \d{4}-\d{2}-\d{2}: [+-]\d[\d.]* in all/);
    expect(text).toMatch(/- VUSAl_EQ: [+-]\d[\d.]* \([+-][\d.]+%\), start [\d.]+ \(40 at [\d.]+ on \d{4}-\d{2}-\d{2}\), now [\d.]+/);
    // The sample account's TSLA fills do not add up to what it holds.
    expect(text).toMatch(/Not valued: TSLA_US_EQ \(TSLA_US_EQ's shares do not add up/);
    expect(describePayload({ ...performance, attributionProblem: "Only today's holdings are known." })).toContain("No gains by instrument: Only today's holdings are known.");
  });

  it("gives the time-weighted return over recorded days with the withdrawal taken out", async () => {
    const services = sample();
    const now = Date.now();
    const day = (ago: number) => ({ date: new Date(now - ago * 86_400_000).toISOString().slice(0, 10), at: new Date(now - ago * 86_400_000 + 60_000).toISOString() });
    // The sample account took out 500 ninety days ago; the value fell by it but the return did not.
    const values = [{ ...day(100), totalValue: 10_500 }, { ...day(80), totalValue: 10_100 }, { ...day(1), totalValue: 10_605 }];
    const performance = await services.insights.performance("demo", { from: new Date(now - 120 * 86_400_000), to: new Date(now) }, undefined, async (account) => {
      // The days are read for the account whose history this is, not whichever was recorded last.
      expect(account).toBe(21_200_000);
      return values;
    });
    expect(performance.valueHistory).toHaveLength(3);
    expect(performance.timeWeighted?.netFlows).toBe(-500);
    expect(performance.timeWeighted?.return).toBeCloseTo((1 + 100 / (10_500 - 500 * (10 / 20))) * 1.05 - 1, 3);
    expect(describePayload(performance)).toMatch(/Time-weighted return from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}: \+6%, with 500 of net withdrawals in between taken out/);
  });

  it("summarizes a tax year with gains and losses apart and says it is not a tax calculation", async () => {
    const services = sample();
    const year = await services.insights.taxYear("demo", { yearStart: "04-06", timeZone: "Europe/London" });
    const text = describePayload(year);
    expect(text).toMatch(/^Tax year \d{4}-04-06 to \d{4}-04-05 \(Europe\/London\)/);
    expect(text).toMatch(/Sales: \d+, proceeds/);
    expect(text).toMatch(/not as the tax due/);
  });

  it("lists each saved target against today's weight", async () => {
    const services = sample();
    await services.targets.set("demo", { targets: [{ instrument: "AAPL_US_EQ", weight: 0.5 }, { instrument: "KO_US_EQ", weight: 0.4 }] });
    const text = describePayload(await services.targets.withDrift(await services.insights.allocation("demo")));
    expect(text).toMatch(/Against targets \(largest drift [\d.]+ points; notices above 5 points\):/);
    expect(text).toMatch(/- AAPL_US_EQ: [\d.]+% now, target 50%, [+-][\d.]+ pts/);
    expect(text).toMatch(/- Cash: [\d.]+% now, target 10%/);
    expect(text).toMatch(/No target \(kept by a rebalance\): .*MSFT_US_EQ/);
    expect(text).toMatch(/- AAPL_US_EQ is [\d.]+% against a 50.0% target/);
  });

  it("gives a day's-move alert's change since the previous close", async () => {
    const services = sample();
    // Set a week ago, so the last session counts whenever the test runs.
    await services.alerts.create({ environment: "demo", instrument: "AAPL_US_EQ", condition: "day_move", percent: 3 }, new Date(Date.now() - 7 * 86_400_000));
    const [report] = await services.alerts.check();
    expect(report?.message).toMatch(/AAPL_US_EQ is at [\d.]+, [+-][\d.]+% since the close on \d{4}-\d{2}-\d{2}/);
    const text = describePayload(await services.automationOverview("demo"));
    expect(text).toMatch(/AAPL_US_EQ \(Apple[^)]*\) day's move of 3% either way \(alt_[\w-]+, DEMO\), last [\d.]+ USD(, triggered [^,]+ at [\d.]+ USD)?(, armed)?, [+-][\d.]+% since the close on \d{4}-\d{2}-\d{2}/);
  });

  it("returns nothing for payloads the summary already covers", () => {
    expect(describePayload({ kind: "unknown" })).toBe("");
    expect(describePayload(null)).toBe("");
  });
});
