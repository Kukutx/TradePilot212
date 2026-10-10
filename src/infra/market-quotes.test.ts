import {describe,expect,it,vi} from "vitest";
import {MemoryStore} from "./state.js";
import {readConfiguration} from "./config.js";
import {TwelveDataQuoteService} from "./market-quotes.js";
const base={
  OWNER_PASSWORD:"test-owner-password-at-least-24",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
};
describe("optional vendor research quotes",()=>{
  it("never guesses an unconfigured quote feed",async()=>{
    const fetcher=vi.fn();
    const svc=new TwelveDataQuoteService(readConfiguration(base),new MemoryStore(),fetcher as typeof fetch);
    await expect(svc.quote("AAPL")).rejects.toThrow(/not enabled/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts a timestamped matching exchange and explicitly disclaims execution",async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({
      symbol:"AAPL",exchange:"NASDAQ",currency:"USD",close:"250.01",
      timestamp:Math.floor(Date.now()/1000),is_extended_hours:false,
    })));
    const config=readConfiguration({...base,TWELVE_DATA_API_KEY:"vendor-key-not-real"});
    const svc=new TwelveDataQuoteService(config,new MemoryStore(),fetcher as typeof fetch);
    const q=await svc.quote("AAPL","USD","NASDAQ");
    expect(q.price).toBe(250.01);
    expect(q.isStale).toBe(false);
    expect(q.usage).toBe("research_reference_not_order_execution");
    expect(q.warnings.join(" ")).toContain("not a Trading 212 execution price");
    expect(JSON.stringify(q)).not.toContain("vendor-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized chunked vendor bodies before consuming all JSON bytes",async()=>{
    let reads=0;
    const fake=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({
      pull(controller){reads++;controller.enqueue(new Uint8Array(36_000));},
    }),{status:200}));
    const config=readConfiguration({...base,TWELVE_DATA_API_KEY:"vendor-test-key"});
    const quotes=new TwelveDataQuoteService(config,new MemoryStore(),fake as typeof fetch);
    await expect(quotes.quote("AAPL")).rejects.toThrow(/Quote response too large/);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(reads).toBeLessThan(8);
  });
  it("rejects venue and currency mismatch, untrusted symbol input and stale quotes",async()=>{
    const config=readConfiguration({...base,TWELVE_DATA_API_KEY:"vendor-key-not-real"});
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({
      symbol:"AAPL",exchange:"NASDAQ",currency:"USD",close:"251.00",
      timestamp:Math.floor((Date.now()-86400_000)/1000),
    })));
    const svc=new TwelveDataQuoteService(config,new MemoryStore(),fetcher as typeof fetch);
    await expect(svc.quote("AAPL","EUR")).rejects.toThrow(/currency/);
    await expect(svc.quote("AAPL","USD","NYSE")).rejects.toThrow(/exchange/);
    await expect(svc.quote("../admin")).rejects.toThrow(/symbol/);
    expect((await svc.quote("AAPL","USD","NASDAQ")).isStale).toBe(true);
  });
});
