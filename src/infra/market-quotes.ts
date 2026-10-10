import {z} from "zod";
import type {Configuration} from "./config.js";
import type {StateStore} from "./state.js";
import {readBoundedUtf8} from "./bounded-body.js";

const quoteSchema=z.object({
  symbol:z.string().min(1),exchange:z.string().min(1).optional(),
  currency:z.string().regex(/^[A-Z]{3}$/),
  close:z.union([z.string(),z.number()]),
  timestamp:z.number().int().positive().optional(),
  is_extended_hours:z.boolean().optional(),
  status:z.string().optional(),
});
export interface VerifiedQuote {
  kind:"provider_quote";
  symbol:string;
  exchange:string|null;
  currency:string;
  price:number;
  quoteAsOf:string|null;
  fetchedAt:string;
  isStale:boolean;
  provider:"Twelve Data";
  sourceUrl:"https://twelvedata.com/docs";
  usage:"research_reference_not_order_execution";
  warnings:string[];
}
/**
 * Optional vendor price feed. Never pretend API timestamps are live execution
 * guarantees, and never send a Trading212 credential to the quote provider.
 */
export class TwelveDataQuoteService {
  constructor(
    private readonly config:Configuration,
    private readonly state:StateStore,
    private readonly fetcher:typeof fetch=fetch,
  ){}
  async quote(symbolInput:string,expectedCurrency?:string,expectedExchange?:string):Promise<VerifiedQuote>{
    const symbol=symbolInput.trim().toUpperCase();
    if(!/^[A-Z0-9.\-]{1,20}$/.test(symbol))
      throw new Error("Use an explicit market symbol (for example AAPL), not an ambiguous broker instrument ID");
    if(expectedCurrency&&!/^[A-Z]{3}$/.test(expectedCurrency))
      throw new Error("Expected quote currency must be uppercase ISO 4217");
    if(expectedExchange&&!/^[A-Za-z0-9.\-]{1,32}$/.test(expectedExchange))
      throw new Error("Expected exchange is invalid");
    const key=this.config.marketResearch.twelveDataKey;
    if(!key)throw new Error("Market quote provider is not enabled; configure TWELVE_DATA_API_KEY");
    const cacheKey=`v3:vendor-quote:${symbol}:${expectedCurrency||""}:${expectedExchange||""}`;
    const cached=await this.state.get<VerifiedQuote>(cacheKey);
    if(cached)return cached;
    const url=new URL("https://api.twelvedata.com/quote");
    url.searchParams.set("symbol",symbol);
    if(expectedExchange)url.searchParams.set("exchange",expectedExchange);
    url.searchParams.set("apikey",key);
    const response=await this.fetcher(url.toString(),{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(10_000),
      headers:{Accept:"application/json"},
    });
    if(!response.ok)throw new Error(`Quote service unavailable (HTTP ${response.status})`);
    if(Number(response.headers.get("content-length")||0)>65_536)throw new Error("Quote response too large");
    const raw=await readBoundedUtf8(response.body,65_536,"Quote response too large");
    const parsed=quoteSchema.parse(JSON.parse(raw) as unknown);
    if(parsed.status==="error"||parsed.symbol.toUpperCase()!==symbol)
      throw new Error("Market quote symbol mismatch or provider error");
    if(expectedCurrency && parsed.currency!==expectedCurrency)
      throw new Error("Provider currency does not match the requested instrument quote currency");
    if(expectedExchange && parsed.exchange?.toUpperCase()!==expectedExchange.toUpperCase())
      throw new Error("Provider exchange mismatch; the listing may be wrong");
    const price=Number(parsed.close);
    if(!Number.isFinite(price)||price<=0)throw new Error("Invalid provider quote");
    const stamp=parsed.timestamp;
    const quoteAsOf=stamp && stamp>0 && stamp<100_000_000_000
      ?new Date(stamp*1000).toISOString():null;
    const age=quoteAsOf?Date.now()-Date.parse(quoteAsOf):Infinity;
    const isStale=!Number.isFinite(age)||age>5*60_000||age< -60_000;
    const result:VerifiedQuote={
      kind:"provider_quote",symbol,exchange:parsed.exchange||null,
      currency:parsed.currency,price,quoteAsOf,fetchedAt:new Date().toISOString(),
      isStale,provider:"Twelve Data",
      sourceUrl:"https://twelvedata.com/docs",
      usage:"research_reference_not_order_execution",
      warnings:[
        "A vendor quote is not a Trading 212 execution price, and does not remove market slippage risk.",
        ...(isStale?["Quote timestamp is absent, stale or in the future. Do not use it as a live fill estimate."]:[]),
        ...(parsed.is_extended_hours?["Quote reflects extended-hours trading."]:[]),
      ],
    };
    await this.state.put(cacheKey,result,Date.now()+30_000);
    return result;
  }
}
