import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

describe("runtime config", () => {
  it("keeps Demo as the safe default environment", () => {
    expect(createConfig({}).defaultTradingEnvironment).toBe("demo");
  });

  it("allows a self-hoster to select Live as the default", () => {
    expect(createConfig({ DEFAULT_TRADING_ENV: "live" }).defaultTradingEnvironment).toBe("live");
  });

  it("allows zero to disable the app-level order caps", () => {
    const config = createConfig({ MAX_ORDER_NOTIONAL: "0", MAX_ORDER_QUANTITY: "0" });
    expect(config.maxOrderNotional).toBe(0);
    expect(config.maxOrderQuantity).toBe(0);
  });

  it("takes Trading 212's 0.15% conversion fee unless FX_FEE_RATE says otherwise", () => {
    expect(createConfig({}).fxFeeRate).toBe(0.0015);
    expect(createConfig({ FX_FEE_RATE: "0" }).fxFeeRate).toBe(0);
    expect(createConfig({ FX_FEE_RATE: "0.005" }).fxFeeRate).toBe(0.005);
    // A percent typed by mistake is refused rather than read as 15%.
    expect(() => createConfig({ FX_FEE_RATE: "0.15" })).toThrow(/FX_FEE_RATE must be a fraction/);
    expect(() => createConfig({ FX_FEE_RATE: "-0.001" })).toThrow(/FX_FEE_RATE/);
  });

  it("rejects unsupported default environments", () => {
    expect(() => createConfig({ DEFAULT_TRADING_ENV: "paper" })).toThrow(/DEFAULT_TRADING_ENV/);
  });

  it("reads the time zone and the tax year's first day, and refuses ones that are not real", () => {
    expect(createConfig({}).timeZone).toBeUndefined();
    expect(createConfig({}).taxYearStart).toBe("01-01");
    const config = createConfig({ TIMEZONE: "europe/london", TAX_YEAR_START: "04-06" });
    expect(config.timeZone).toBe("Europe/London");
    expect(config.taxYearStart).toBe("04-06");
    expect(() => createConfig({ TIMEZONE: "Mars/Olympus" })).toThrow(/TIMEZONE/);
    expect(() => createConfig({ TAX_YEAR_START: "02-30" })).toThrow(/TAX_YEAR_START/);
    expect(() => createConfig({ TAX_YEAR_START: "4-6" })).toThrow(/TAX_YEAR_START/);
  });

  it("takes another address for Trading 212's API over HTTPS only, and never with the sample account", () => {
    expect(createConfig({}).trading212.live.baseUrl).toBe("https://live.trading212.com/api/v0");
    expect(createConfig({ T212_LIVE_BASE_URL: "https://proxy.example/t212/api/v0/" }).trading212.live.baseUrl).toBe("https://proxy.example/t212/api/v0");
    expect(createConfig({ T212_DEMO_BASE_URL: "http://localhost:9212/api/v0" }).trading212.demo.baseUrl).toBe("http://localhost:9212/api/v0");
    expect(() => createConfig({ T212_LIVE_BASE_URL: "http://proxy.example/api/v0" })).toThrow(/HTTPS/);
    expect(() => createConfig({ T212_DEMO_BASE_URL: "https://user:pass@proxy.example/api" })).toThrow(/plain URL/);
    expect(() => createConfig({ T212_DEMO_BASE_URL: "not a url" })).toThrow(/must be a URL/);
    expect(createConfig({ TRADEPILOT_SAMPLE_DATA: "true", T212_DEMO_BASE_URL: "https://proxy.example/api" }).trading212.demo.baseUrl).not.toContain("proxy.example");
  });
});
