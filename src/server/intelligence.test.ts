import { describe, expect, it, vi } from "vitest";
import { readConfiguration } from "../infra/config.js";
import { MemoryStore } from "../infra/state.js";
import { samplePortfolio } from "../domain/sample.js";
import type { BrokerReader } from "../infra/broker.js";
import { IntelligenceService } from "./intelligence.js";

const config = readConfiguration({
  OWNER_PASSWORD: "sample-test-owner-password-12345",
  JWT_SIGNING_SECRET: "0123456789abcdef".repeat(3),
  DATA_SOURCE: "sample",
});
function fixture() {
  const state = new MemoryStore();
  const getPortfolio = vi.fn(async () => samplePortfolio("demo"));
  const getRecentOrders = vi.fn(async () => ({ items: [], nextCursor: null }));
  const broker: BrokerReader = { getPortfolio, getRecentOrders };
  const service = new IntelligenceService(config, state, broker);
  return { service, state, getPortfolio, getRecentOrders };
}

describe("V3 portfolio intelligence and local monitoring", () => {
  it("keeps all sample outputs explicitly synthetic without broker requests", async () => {
    const { service, getPortfolio, getRecentOrders } = fixture();
    const portfolio = await service.portfolio("demo");
    const risk = await service.analysis("demo");
    const brief = await service.dailyBrief("demo");
    const attention=await service.attention("demo");
    expect(attention.source).toBe("sample");
    expect(attention.brokerWrites).toBe(0);
    const history = await service.recentOrders("demo");
    expect(portfolio.source).toBe("sample");
    expect(risk.source).toBe("sample");
    expect(risk.limitations.join(" ")).toMatch(/SYNTHETIC/);
    expect(brief.source).toBe("sample");
    expect(history.source).toBe("sample");
    expect(getPortfolio).not.toHaveBeenCalled();
    expect(getRecentOrders).not.toHaveBeenCalled();
  });

  it("creates alerts only at first threshold crossing, never changes broker state", async () => {
    const { service, getPortfolio, getRecentOrders } = fixture();
    const rule = await service.createRule("demo", "cash_below", 20);
    expect(rule.kind).toBe("cash_below");
    const first = await service.scan("demo");
    const second = await service.scan("demo");
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(first.brokerWrites).toBe(0);
    expect((await service.events("demo")).events).toHaveLength(1);
    expect((await service.events("live")).events).toHaveLength(0);
    const trend = await service.trend("demo");
    expect(trend.kind).toBe("risk_trend");
    expect(trend.source).toBe("sample");
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0]?.cashPercent).toBeCloseTo(17.86);
    expect(trend.absoluteValueChange).toBeNull();
    expect(trend.notes.join(" ")).toMatch(/NOT investment returns/);
    expect(await service.deleteRule(rule.id)).toBe(true);
    expect(await service.listRules("demo")).toHaveLength(0);
    expect(getPortfolio).not.toHaveBeenCalled();
    expect(getRecentOrders).not.toHaveBeenCalled();
  });

  it("enables basic monitoring once and retains preexisting custom thresholds",async()=>{
    const {service,getPortfolio}=fixture();
    const custom=await service.createRule("demo","cash_below",12);
    const result=await service.enableBasicMonitoring("demo");
    expect(result.kind).toBe("monitoring_setup");
    expect(result.created).toHaveLength(2);
    expect(result.activeRules).toHaveLength(3);
    expect(result.activeRules.find(x=>x.kind==="cash_below")?.id).toBe(custom.id);
    expect(result.activeRules.find(x=>x.kind==="cash_below")?.thresholdPercent).toBe(12);
    expect(result.brokerWrites).toBe(0);
    const repeat=await service.enableBasicMonitoring("demo");
    expect(repeat.created).toHaveLength(0);
    expect(repeat.activeRules).toHaveLength(3);
    expect(repeat.scheduledEvaluation).toMatch(/Sample mode/);
    expect(getPortfolio).not.toHaveBeenCalled();
  });
  it("keeps monitoring presets separate for Demo and Live environments",async()=>{
    const {service}=fixture();
    await service.enableBasicMonitoring("demo");
    const live=await service.enableBasicMonitoring("live");
    expect(live.activeRules).toHaveLength(3);
    expect((await service.listRules("demo"))).toHaveLength(3);
    expect((await service.listRules("live"))).toHaveLength(3);
  });

  it("preserves exact historical int64 IDs and hides unsafe rounded numeric identifiers",async()=>{
    const broker:BrokerReader={
      async getPortfolio(environment){
        return {...samplePortfolio(environment),source:"trading212" as const};
      },
      async getRecentOrders(){
        return {items:[
          {id:Number.MAX_SAFE_INTEGER+8,ticker:"AAPL_US_EQ",type:"LIMIT",
            quantity:1,createdAt:"2026-10-10T12:00:00Z"},
          {id:"9223372036854775807",ticker:"MSFT_US_EQ",status:"FILLED",
            quantity:2,apiSecret:"should never leave broker adapter"},
        ],nextCursor:null};
      },
    };
    const realConfig=readConfiguration({
      OWNER_PASSWORD:"owner-password-at-least-24-characters",
      JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
      DATA_SOURCE:"trading212",T212_DEMO_KEY:"mock",T212_DEMO_SECRET:"mock-secret",
    });
    const intelligence=new IntelligenceService(realConfig,new MemoryStore(),broker);
    const history=await intelligence.recentOrders("demo");
    expect(history.orders[0]?.id).toBeNull();
    expect(history.orders[1]?.id).toBe("9223372036854775807");
    expect(JSON.stringify(history)).not.toContain("apiSecret");
  });

  it("rejects invalid threshold combinations", async () => {
    const { service } = fixture();
    await expect(service.createRule("demo", "unrealized_loss_below", 20)).rejects.toThrow();
    await expect(service.createRule("demo", "cash_below", -5)).rejects.toThrow();
    await expect(service.createRule("demo", "largest_position_above", Number.NaN)).rejects.toThrow();
  });
});
