import {OwnerPreferencesStore,zonedHourAndDate} from "../domain/preferences.js";
import type {Environment} from "../domain/types.js";
import type {Configuration} from "../infra/config.js";
import type {Notifier} from "../infra/notification.js";
import type {StateStore} from "../infra/state.js";
import type {IntelligenceService} from "./intelligence.js";

export interface StoredDailyReport {
  kind:"daily_report";
  environment:Environment;
  localDate:string;
  timezone:string;
  createdAt:string;
  source:"trading212";
  reviewCount:number;
  importantItems:{id:string;title:string;asOf:string;provenance:string}[];
  newThresholdEvents:number;
  notification:"disabled"|"unconfigured"|"unchanged"|"sent"|"failed";
  brokerWrites:0;
}
function fingerprint(ids:string[],cash:number|null,coverage:number|null) {
  // Coarse bands suppress notifications for insignificant account movement.
  const band=(value:number|null)=>value===null?"missing":Math.floor(value/5);
  return JSON.stringify({ids:ids.sort(),cash:band(cash),coverage:band(coverage)});
}
export class DailyAutomation {
  constructor(
    private readonly config:Configuration,
    private readonly state:StateStore,
    private readonly intelligence:IntelligenceService,
    private readonly notifier:Notifier,
    private readonly now:()=>Date=()=>new Date(),
  ){}
  async getReport(environment:Environment,localDate:string):Promise<StoredDailyReport|undefined>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(localDate))throw new Error("Invalid local day");
    return this.state.get<StoredDailyReport>(`v3:daily-report:${environment}:${localDate}`);
  }
  async run(environment:Environment):Promise<
    {status:"skipped";reason:string}|{status:"complete";report:StoredDailyReport}
  >{
    const preferences=await new OwnerPreferencesStore(this.state,this.config.defaultEnvironment).get();
    if(!preferences.dailyBrief.enabled)return {status:"skipped",reason:"Daily briefs are disabled"};
    if(environment!==preferences.defaultEnvironment && !(environment==="live"&&preferences.dailyBrief.includeLive))
      return {status:"skipped",reason:"Environment not enabled for daily brief"};
    if(this.config.source!=="trading212"||!this.config.broker[environment].key)
      return {status:"skipped",reason:"Real broker read credentials are required; sample is never delivered"};
    const now=this.now();
    const {hour,day}=zonedHourAndDate(now,preferences.timezone);
    if(hour!==preferences.dailyBrief.hour)
      return {status:"skipped",reason:"Outside the configured local-hour schedule"};
    const key=`v3:daily-run:${environment}:${day}`;
    const owner=crypto.randomUUID();
    // Idempotency lease is retained even after an ambiguous external send;
    // do not accidentally email the same market observation twice.
    if(!(await this.state.claim(key,owner,now.getTime()+72*3600_000)))
      return {status:"skipped",reason:"Today's report was already started"};
    let delivery:StoredDailyReport["notification"]="disabled";
    try{
      const scan=await this.intelligence.scan(environment);
      const attention=await this.intelligence.attention(environment);
      const important=attention.items.map(item=>({
        id:item.id,title:item.title.zh,asOf:item.asOf,provenance:item.provenance,
      }));
      const nextFingerprint=fingerprint(
        attention.items.filter(item=>item.priority==="review").map(item=>item.id),
        attention.cashPercent,attention.valuationCoveragePercent,
      );
      const previous=await this.state.get<string>(`v3:last-notified:${environment}`);
      if(preferences.dailyBrief.email){
        if(!this.notifier.configured())delivery="unconfigured";
        else if(preferences.dailyBrief.onlyOnChange &&
          scan.created===0 && (previous===nextFingerprint || attention.reviewCount===0))
          delivery="unchanged";
        else{
          // Non-idempotent external delivery is not retried on timeouts.
          try{
            await this.notifier.send({
              environment,day,reviewCount:attention.reviewCount,source:"trading212",
              lines:attention.items.slice(0,4).map(item=>item.title.en),
            });
            delivery="sent";
            await this.state.put(`v3:last-notified:${environment}`,nextFingerprint);
          }catch{
            delivery="failed";
          }
        }
      }
      const report:StoredDailyReport={
        kind:"daily_report",environment,localDate:day,timezone:preferences.timezone,
        createdAt:this.now().toISOString(),source:"trading212",
        reviewCount:attention.reviewCount,importantItems:important,
        newThresholdEvents:scan.created,notification:delivery,brokerWrites:0,
      };
      await this.state.put(`v3:daily-report:${environment}:${day}`,report,Date.now()+90*86400_000);
      return {status:"complete",report};
    }catch(error){
      // A failed broker read may be retried explicitly the next day, but
      // never repeat a possibly sent email from the current run.
      throw error;
    }
  }
}
