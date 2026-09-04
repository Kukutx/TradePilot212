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

  it("rejects unsupported default environments", () => {
    expect(() => createConfig({ DEFAULT_TRADING_ENV: "paper" })).toThrow(/DEFAULT_TRADING_ENV/);
  });
});
