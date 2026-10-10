import {describe, expect, it} from "vitest";
import {samplePortfolio} from "./sample.js";
import {analyzePortfolio} from "./analytics.js";
import {buildAttentionCenter} from "./attention.js";
import type {MonitorEvent} from "./types.js";
const now=new Date("2026-10-10T15:00:00Z");
describe("personal read-only attention center",()=>{
  it("labels synthetic data and does not generate unsupported investment actions",()=>{
    const s=samplePortfolio("demo",now), a=analyzePortfolio(s);
    const center=buildAttentionCenter(s,a,[],now);
    expect(center.kind).toBe("attention_center");
    expect(center.source).toBe("sample");
    expect(center.brokerWrites).toBe(0);
    expect(center.items.some(i=>i.kind==="sample")).toBe(true);
    expect(center.limitations[0]?.en).toMatch(/not quote time/);
    expect(center.reviewCount).toBe(0);
  });
  it("prioritizes verified data gaps before non-actionable historical events",()=>{
    const s=samplePortfolio("demo",now);
    s.holdings[0]!.valueInAccountCurrency=null;
    s.holdings[0]!.valueProvenance="unknown";
    const a=analyzePortfolio(s);
    const event:MonitorEvent={id:"event-1",ruleId:"r1",environment:"demo",status:"triggered",
      observedAt:new Date(now.getTime()-3600_000).toISOString(),
      thresholdPercent:35,observedPercent:40,detail:"Historical threshold"};
    const center=buildAttentionCenter(s,a,[event],now);
    expect(center.items[0]?.kind).toBe("valuation_gap");
    expect(center.reviewCount).toBe(1);
    expect(center.items.find(i=>i.kind==="monitor_event")?.priority).toBe("information");
    expect(center.items.find(i=>i.kind==="valuation_gap")?.route).toBe("risk");
  });
  it("does not present old events as current risks or cross account environments",()=>{
    const s=samplePortfolio("live",now),a=analyzePortfolio(s);
    const historical=(environment:"demo"|"live",time:string):MonitorEvent=>({
      id:time+environment,environment,ruleId:"r",status:"triggered",
      observedAt:time,thresholdPercent:20,observedPercent:10,detail:"Past trigger",
    });
    const center=buildAttentionCenter(s,a,[
      historical("live",new Date(now.getTime()-10*86400_000).toISOString()),
      historical("demo",now.toISOString()),
    ],now);
    expect(center.items.every(i=>i.kind!=="monitor_event")).toBe(true);
  });
  it("fails closed when different account sources are mixed",()=>{
    const s=samplePortfolio("demo",now),a=analyzePortfolio(s);
    expect(()=>buildAttentionCenter(s,{...a,environment:"live"},[],now)).toThrow(/different sources/);
  });
});
