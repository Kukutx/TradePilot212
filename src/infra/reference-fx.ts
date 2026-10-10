import type {StateStore} from "./state.js";

export interface ReferenceFx {
  kind:"reference_fx";
  from:string;
  to:string;
  rate:number|null;
  asOf:string|null;
  fetchedAt:string;
  source:"European Central Bank";
  sourceUrls:string[];
  status:"reference"|"stale"|"missing"|"date_mismatch"|"identity";
  usage:"reference_only_not_executable";
  warnings:string[];
}
interface EcbObservation{currency:string;date:string;perEuro:number;url:string;}
function csvFields(line:string):string[]{
  const fields:string[]=[];let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i]!;
    if(c==='"'){if(quoted&&line[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===","&&!quoted){fields.push(cell);cell="";}
    else cell+=c;
  }
  if(quoted)throw new Error("Malformed ECB CSV");
  fields.push(cell);
  return fields;
}
export function parseEcbCsv(csv:string,currency:string,url:string):EcbObservation{
  const lines=csv.replace(/^\uFEFF/,"").split(/\r?\n/).filter(line=>line.trim());
  if(lines.length<2)throw new Error("ECB reference data missing");
  const headers=csvFields(lines[0]!);
  const ixTime=headers.indexOf("TIME_PERIOD"),ixValue=headers.indexOf("OBS_VALUE");
  if(ixTime<0||ixValue<0)throw new Error("ECB reference columns missing");
  const row=csvFields(lines[lines.length-1]!);
  const date=row[ixTime]||"",rate=Number(row[ixValue]);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(rate)||rate<=0)
    throw new Error("ECB reference date or rate invalid");
  return {currency,date,perEuro:rate,url};
}
/** Fixed official ECB URL only; no user-provided fetch origin or SSRF surface. */
export class ReferenceFxService {
  constructor(private readonly state:StateStore,private readonly fetcher:typeof fetch=fetch){}
  private async observation(currency:string):Promise<EcbObservation>{
    if(!/^[A-Z]{3}$/.test(currency)||currency==="EUR")
      throw new Error("Unsupported ECB currency series");
    const cacheKey=`v3:reference-fx:${currency}`;
    const cached=await this.state.get<EcbObservation>(cacheKey);
    if(cached)return cached;
    const url=`https://data-api.ecb.europa.eu/service/data/EXR/D.${currency}.EUR.SP00.A?lastNObservations=1&format=csvdata`;
    const response=await this.fetcher(url,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(12_000),
      headers:{Accept:"text/csv"},
    });
    if(!response.ok)throw new Error(`ECB reference rate unavailable: HTTP ${response.status}`);
    if(Number(response.headers.get("content-length")||0)>65_536)
      throw new Error("ECB rate response exceeds limit");
    const reader=response.body?.getReader();
    if(!reader)throw new Error("ECB returned empty response");
    const chunks:Uint8Array[]=[];let size=0;
    try{
      while(true){
        const next=await reader.read();
        if(next.done)break;
        size+=next.value.byteLength;
        if(size>65_536)throw new Error("ECB rate response too large");
        chunks.push(next.value);
      }
    }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const bytes=new Uint8Array(size);let cursor=0;
    for(const chunk of chunks){bytes.set(chunk,cursor);cursor+=chunk.byteLength;}
    const observation=parseEcbCsv(new TextDecoder().decode(bytes),currency,url);
    await this.state.put(cacheKey,observation,Date.now()+3600_000);
    return observation;
  }
  async rate(fromInput:string,toInput:string,now=new Date()):Promise<ReferenceFx>{
    const from=fromInput.trim().toUpperCase(),to=toInput.trim().toUpperCase();
    if(!/^[A-Z]{3}$/.test(from)||!/^[A-Z]{3}$/.test(to))
      throw new Error("ISO 4217 currency codes required");
    if(from===to)return {kind:"reference_fx",from,to,rate:1,asOf:null,
      fetchedAt:now.toISOString(),source:"European Central Bank",sourceUrls:[],
      status:"identity",usage:"reference_only_not_executable",
      warnings:["Same-currency identity rate; not a market quote."]};
    const results=await Promise.all([
      from==="EUR"?Promise.resolve(null):this.observation(from),
      to==="EUR"?Promise.resolve(null):this.observation(to),
    ]);
    const [left,right]=results;
    const dates=[left?.date,right?.date].filter((x):x is string=>Boolean(x));
    const matches=dates.every(d=>d===dates[0]);
    const rate=matches?(right?.perEuro||1)/(left?.perEuro||1):null;
    const asOf=matches?(dates[0]||null):null;
    const age=asOf?Math.floor((now.getTime()-Date.parse(asOf+"T00:00:00Z"))/86400_000):Infinity;
    const stale=age>7 || age<0;
    const warnings=[
      "ECB rates are published reference observations, not real-time executable bid/ask prices.",
      ...(!matches?["Currency series use different ECB observation dates; no combined conversion is reported."]:[]),
      ...(matches && stale?["Reference observation is older than seven days or future-dated."]:[]),
    ];
    return {
      kind:"reference_fx",from,to,rate,asOf,fetchedAt:now.toISOString(),
      source:"European Central Bank",sourceUrls:results.filter(Boolean).map(v=>v!.url),
      status:!matches?"date_mismatch":rate===null?"missing":stale?"stale":"reference",
      usage:"reference_only_not_executable",warnings,
    };
  }
}
