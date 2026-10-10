import {describe,expect,it,vi} from "vitest";
import {MemoryStore} from "./state.js";
import {ReferenceFxService,parseEcbCsv} from "./reference-fx.js";
const usd="KEY,TIME_PERIOD,OBS_VALUE\nUSD,2026-10-09,1.15";
describe("official ECB reference FX",()=>{
  it("converts EUR/USD and USD/EUR from a dated ECB observation with exact source",async()=>{
    const fetcher=vi.fn(async()=>new Response(usd,{status:200}));
    const svc=new ReferenceFxService(new MemoryStore(),fetcher as typeof fetch);
    const eur=await svc.rate("EUR","USD",new Date("2026-10-10T08:00:00Z"));
    const usdToEur=await svc.rate("USD","EUR",new Date("2026-10-10T08:00:00Z"));
    expect(eur.rate).toBeCloseTo(1.15);
    expect(usdToEur.rate).toBeCloseTo(1/1.15);
    expect(eur.status).toBe("reference");
    expect(eur.sourceUrls[0]).toContain("data-api.ecb.europa.eu");
    expect(eur.warnings.join(" ")).toContain("not real-time executable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not combine different observation dates",async()=>{
    const fetcher=vi.fn(async(url:string)=>
      new Response(url.includes(".USD.")?"KEY,TIME_PERIOD,OBS_VALUE\nUSD,2026-10-09,1.15":
        "KEY,TIME_PERIOD,OBS_VALUE\nGBP,2026-10-08,0.9",{status:200}));
    const svc=new ReferenceFxService(new MemoryStore(),fetcher as typeof fetch);
    const result=await svc.rate("USD","GBP",new Date("2026-10-10T12:00:00Z"));
    expect(result.rate).toBeNull();
    expect(result.status).toBe("date_mismatch");
  });
  it("rejects malicious currencies and malformed inputs before fetch",async()=>{
    const fetcher=vi.fn();
    const svc=new ReferenceFxService(new MemoryStore(),fetcher as typeof fetch);
    await expect(svc.rate("EUR","USD/path")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(()=>parseEcbCsv("KEY,TIME_PERIOD,OBS_VALUE\nUSD,2026-10-09,NaN",
      "USD","https://data-api.ecb.europa.eu")).toThrow();
  });
  it("labels old reference rates as stale rather than live",async()=>{
    const svc=new ReferenceFxService(new MemoryStore(),vi.fn(async()=>new Response(usd)) as typeof fetch);
    const r=await svc.rate("EUR","USD",new Date("2026-11-10T12:00:00Z"));
    expect(r.status).toBe("stale");
    expect(r.rate).toBeCloseTo(1.15);
  });
});
