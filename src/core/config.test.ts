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
});
