import { describe,expect,it } from "vitest";
import { executionPermitted,readConfiguration } from "./config.js";
const base={
  PUBLIC_ORIGIN:"https://tradepilot.example.test",
  OWNER_PASSWORD:"test-owner-password-at-least-24",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  T212_DEMO_KEY:"demo-key",T212_DEMO_SECRET:"demo-secret",
  T212_LIVE_KEY:"live-key",T212_LIVE_SECRET:"live-secret",
};
describe("private personal execution gates",()=>{
  it("starts read-only by default even with Demo and Live API credentials",()=>{
    const config=readConfiguration({...base,DATA_SOURCE:"trading212"});
    expect(executionPermitted(config,"demo")).toBe(false);
    expect(executionPermitted(config,"live")).toBe(false);
    expect(config.personalTrading.allowUnquotedLiveBuys).toBe(false);
  });
  it("cannot enable execution using synthetic sample data",()=>{
    expect(()=>readConfiguration({...base,DATA_SOURCE:"sample",PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"a".repeat(48)})).toThrow(/real source/);
  });
  it("requires an independently generated human secret",()=>{
    expect(()=>readConfiguration({...base,DATA_SOURCE:"trading212",PERSONAL_TRADING_ENABLED:"true"})).toThrow(/independent/);
    expect(()=>readConfiguration({...base,DATA_SOURCE:"trading212",PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:base.OWNER_PASSWORD})).toThrow(/independent/);
  });
  it("supports private Demo execution without silently enabling Live",()=>{
    const config=readConfiguration({...base,DATA_SOURCE:"trading212",
      PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"a".repeat(48)});
    expect(executionPermitted(config,"demo")).toBe(true);
    expect(executionPermitted(config,"live")).toBe(false);
  });
  it("supports a separate explicit owner decision about unpriced Live buys",()=>{
    const selected=readConfiguration({...base,DATA_SOURCE:"trading212",
      PERSONAL_TRADING_ENABLED:"true",PERSONAL_LIVE_TRADING_ENABLED:"true",
      PERSONAL_APPROVAL_SECRET:"x".repeat(48),PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS:"true"});
    expect(selected.personalTrading.allowUnquotedLiveBuys).toBe(true);
    expect(executionPermitted(selected,"live")).toBe(true);
  });
  it("requires separate Live opt-in and broker credentials",()=>{
    expect(()=>readConfiguration({...base,DATA_SOURCE:"trading212",PERSONAL_LIVE_TRADING_ENABLED:"true"})).toThrow(/requires/);
    const config=readConfiguration({...base,DATA_SOURCE:"trading212",
      PERSONAL_TRADING_ENABLED:"true",PERSONAL_LIVE_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"b".repeat(48)});
    expect(executionPermitted(config,"live")).toBe(true);
    const missing=readConfiguration({...base,T212_LIVE_KEY:"",T212_LIVE_SECRET:"",DATA_SOURCE:"trading212",
      PERSONAL_TRADING_ENABLED:"true",PERSONAL_LIVE_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"b".repeat(48)});
    expect(executionPermitted(missing,"live")).toBe(false);
  });
});
