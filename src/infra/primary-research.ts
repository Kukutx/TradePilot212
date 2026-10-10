import {z} from "zod";
import type {Configuration} from "./config.js";
import type {StateStore} from "./state.js";

const secTickerEntry=z.object({cik_str:z.number().int().nonnegative(),ticker:z.string(),title:z.string()});
const submission=z.object({
  cik:z.number().int().nonnegative(),name:z.string(),
  filings:z.object({recent:z.object({
    accessionNumber:z.array(z.string()),
    form:z.array(z.string()),
    filingDate:z.array(z.string()),
    primaryDocument:z.array(z.string()),
  })}),
});
export interface SecFiling {
  form:string;date:string;accession:string;documentUrl:string;
}
export interface SecFilingResult {
  kind:"primary_filings";
  symbol:string;
  cik:string;
  company:string;
  fetchedAt:string;
  source:"US Securities and Exchange Commission EDGAR";
  filings:SecFiling[];
  sourceUrl:string;
  limitation:"filing_metadata_only_not_analyzed";
}
/** All upstream network targets are fixed official SEC domains, not model-supplied URLs. */
export class SecResearchService {
  constructor(
    private readonly config:Configuration,
    private readonly store:StateStore,
    private readonly fetcher:typeof fetch=fetch,
  ){}
  private async read(url:string,maxBytes:number):Promise<unknown>{
    if(!this.config.marketResearch.secContact)
      throw new Error("SEC access disabled: owner must configure SEC_CONTACT_EMAIL");
    const response=await this.fetcher(url,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(12_000),
      headers:{
        Accept:"application/json",
        "User-Agent":`TradePilot212Personal ${this.config.marketResearch.secContact}`,
      },
    });
    if(!response.ok)throw new Error(`SEC data unavailable (HTTP ${response.status})`);
    if(Number(response.headers.get("content-length")||0)>maxBytes)throw new Error("SEC data exceeds limit");
    const reader=response.body?.getReader();
    if(!reader)throw new Error("Empty SEC document");
    const chunks:Uint8Array[]=[];let size=0;
    try{
      while(true){
        const next=await reader.read();if(next.done)break;
        size+=next.value.byteLength;
        if(size>maxBytes)throw new Error("SEC data exceeds limit");
        chunks.push(next.value);
      }
    }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const bytes=new Uint8Array(size);let pos=0;
    for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  private async company(symbol:string):Promise<z.infer<typeof secTickerEntry>>{
    const cached=await this.store.get<z.infer<typeof secTickerEntry>>(`v3:sec-symbol:${symbol}`);
    if(cached)return cached;
    const list=await this.read("https://www.sec.gov/files/company_tickers.json",3*1024*1024);
    const entries=z.record(z.string(),secTickerEntry).parse(list);
    const target=Object.values(entries).find(item=>item.ticker.toUpperCase()===symbol);
    if(!target)throw new Error("SEC company not found for supplied ticker");
    await this.store.put(`v3:sec-symbol:${symbol}`,target,Date.now()+24*3600_000);
    return target;
  }
  async filings(symbolInput:string):Promise<SecFilingResult>{
    const symbol=symbolInput.trim().toUpperCase();
    if(!/^[A-Z0-9.\-]{1,15}$/.test(symbol))throw new Error("Invalid US SEC symbol");
    const info=await this.company(symbol);
    const cik=String(info.cik_str).padStart(10,"0");
    const sourceUrl=`https://data.sec.gov/submissions/CIK${cik}.json`;
    const cached=await this.store.get<z.infer<typeof submission>>(`v3:sec-submissions:${cik}`);
    const parsed=cached || submission.parse(await this.read(sourceUrl,5*1024*1024));
    if(parsed.cik!==info.cik_str)throw new Error("SEC filing CIK mismatch");
    if(!cached)await this.store.put(`v3:sec-submissions:${cik}`,parsed,Date.now()+60*60_000);
    const {accessionNumber,form,filingDate,primaryDocument}=parsed.filings.recent;
    const filings:SecFiling[]=[];
    const limit=Math.min(form.length,accessionNumber.length,filingDate.length,primaryDocument.length);
    for(let i=0;i<limit&&filings.length<10;i++){
      const kind=form[i]||"",acc=accessionNumber[i]||"",date=filingDate[i]||"",doc=primaryDocument[i]||"";
      if(!["8-K","10-Q","10-K","20-F","6-K","40-F","4"].includes(kind) ||
         !/^\d{10}-\d{2}-\d{6}$/.test(acc) ||
         !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
         !/^[A-Za-z0-9._-]{1,180}$/.test(doc))continue;
      const path=`https://www.sec.gov/Archives/edgar/data/${info.cik_str}/${acc.replaceAll("-","")}/${doc}`;
      filings.push({form:kind,date,accession:acc,documentUrl:path});
    }
    return {
      kind:"primary_filings",symbol,cik,company:parsed.name,
      fetchedAt:new Date().toISOString(),
      source:"US Securities and Exchange Commission EDGAR",
      filings,sourceUrl,limitation:"filing_metadata_only_not_analyzed",
    };
  }
}
