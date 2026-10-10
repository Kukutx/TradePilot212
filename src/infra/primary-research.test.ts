import {describe,expect,it,vi} from "vitest";
import {MemoryStore} from "./state.js";
import {readConfiguration} from "./config.js";
import {SecResearchService} from "./primary-research.js";
const config=readConfiguration({
  OWNER_PASSWORD:"test-owner-password-at-least-24",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  SEC_CONTACT_EMAIL:"owner@example.org",
});
const listings={"0":{cik_str:320193,ticker:"AAPL",title:"Apple Inc."}};
const filing={
  cik:320193,name:"Apple Inc.",
  filings:{recent:{
    accessionNumber:["0000320193-26-000099","0000320193-26-000100"],
    form:["10-Q","S-1"],filingDate:["2026-10-09","2026-10-09"],
    primaryDocument:["aapl-20261009.htm","other.htm"],
  }},
};
describe("primary sourced SEC research",()=>{
  it("resolves official SEC company ticker, bounded citations and caches",async()=>{
    const fetcher=vi.fn(async(input:string,init?:RequestInit)=>{
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string,string>)["User-Agent"]).toContain("owner@example.org");
      return new Response(JSON.stringify(input.includes("company_tickers.json")?listings:filing));
    });
    const svc=new SecResearchService(config,new MemoryStore(),fetcher as typeof fetch);
    const first=await svc.filings("AAPL"),again=await svc.filings("AAPL");
    expect(first.filings).toHaveLength(1);
    expect(first.filings[0]?.documentUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000099/aapl-20261009.htm");
    expect(first.source).toContain("Securities and Exchange Commission");
    expect(first.limitation).toBe("filing_metadata_only_not_analyzed");
    expect(again.filings).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects user-supplied URLs and does not contact untrusted endpoints",async()=>{
    const fetcher=vi.fn();
    const svc=new SecResearchService(config,new MemoryStore(),fetcher as typeof fetch);
    await expect(svc.filings("https://169.254.169.254")).rejects.toThrow(/symbol/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never sends a request without SEC fair-access owner identification",async()=>{
    const noContact=readConfiguration({
      OWNER_PASSWORD:"test-owner-password-at-least-24",
      JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
    });
    const fetcher=vi.fn();
    await expect(new SecResearchService(noContact,new MemoryStore(),fetcher as typeof fetch).filings("AAPL"))
      .rejects.toThrow(/SEC_CONTACT_EMAIL/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
