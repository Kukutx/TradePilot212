import {describe,expect,it} from "vitest";
import type {TradeIdea} from "./trading.js";
import {auditResearchIdea} from "./research.js";
const now=Date.parse("2026-10-10T12:00:00Z");
const complete:TradeIdea={
  ticker:"AAPL_US_EQ",horizon:"short",action:"buy",score:99,risk:"high",
  rationale:"Model-supplied hypothesis, not validated.",
  thesis:"Detailed example thesis",catalysts:["Product launch"],
  risks:["Valuation risk"],counterCase:"Competitive erosion",
  sources:["https://example.com/research/2026/report"],
  analysisAsOf:new Date(now-30_000).toISOString(),
  referencePrice:100,referencePriceAt:new Date(now-45_000).toISOString(),
};
describe("AI research evidence completeness",()=>{
  it("never turns a high AI score or all fields into verified investment claims",()=>{
    const assessment=auditResearchIdea(complete,now);
    expect(assessment.completenessPercent).toBe(100);
    expect(assessment.claimVerification).toBe("not_performed");
    expect(assessment.traceableLinks).toBe(1);
    expect(assessment.analysisFreshness).toBe("current");
    expect(assessment.referencePriceFreshness).toBe("current");
    expect(assessment.warningMessages.join(" ")).toMatch(/not been independently verified/);
  });
  it("flags missing sources, stale research and stale executable price inputs",()=>{
    const assessment=auditResearchIdea({
      ...complete,score:100,sources:[],thesis:"",risks:[],counterCase:"",
      analysisAsOf:new Date(now-4*86400_000).toISOString(),
      referencePriceAt:new Date(now-15*60_000).toISOString(),
    },now);
    expect(assessment.completenessPercent).toBe(10);
    expect(assessment.analysisFreshness).toBe("stale");
    expect(assessment.referencePriceFreshness).toBe("stale");
    expect(assessment.warningMessages.join(" ")).toMatch(/traceable HTTPS source/);
  });
  it("does not count internal links, insecure URLs or future-dated research",()=>{
    const assessment=auditResearchIdea({
      ...complete,sources:["http://example.com/report","https://127.0.0.1/private","https://example.local/report"],
      analysisAsOf:new Date(now+60*60_000).toISOString(),
    },now);
    expect(assessment.traceableLinks).toBe(0);
    expect(assessment.analysisFreshness).toBe("future");
  });
  it("does not require executable price timestamps for watch-only research",()=>{
    expect(auditResearchIdea({...complete,action:"watch",referencePriceAt:undefined},now)
      .referencePriceFreshness).toBe("not_applicable");
  });
});
