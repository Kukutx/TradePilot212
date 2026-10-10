import { z } from "zod";
import type { Environment } from "./types.js";
import type { StateStore } from "../infra/state.js";

export const preferencesSchema=z.object({
  locale:z.enum(["zh","en"]),
  defaultEnvironment:z.enum(["demo","live"]),
  timezone:z.string().min(1).max(64).refine(value=>{
    try { new Intl.DateTimeFormat("en",{timeZone:value}).format(new Date());return true; }
    catch {return false;}
  },"Unknown IANA timezone"),
  dailyBrief:z.object({
    enabled:z.boolean(),
    hour:z.number().int().min(0).max(23),
    onlyOnChange:z.boolean(),
    includeLive:z.boolean(),
    email:z.boolean(),
  }).strict(),
}).strict();
export type OwnerPreferences=z.infer<typeof preferencesSchema>;
export function defaultPreferences(environment:Environment="demo"):OwnerPreferences{
  return {
    locale:"zh",defaultEnvironment:environment,timezone:"UTC",
    dailyBrief:{enabled:false,hour:8,onlyOnChange:true,includeLive:false,email:false},
  };
}
export class OwnerPreferencesStore {
  constructor(private readonly state:StateStore,private readonly fallback:Environment="demo"){}
  async get():Promise<OwnerPreferences>{
    const value=await this.state.get<OwnerPreferences>("v3:owner-preferences");
    return value?preferencesSchema.parse(value):defaultPreferences(this.fallback);
  }
  async save(value:unknown):Promise<OwnerPreferences>{
    const parsed=preferencesSchema.parse(value);
    await this.state.put("v3:owner-preferences",parsed);
    return parsed;
  }
}
export function zonedHourAndDate(date:Date,timezone:string):{hour:number;day:string}{
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",hourCycle:"h23",
  }).formatToParts(date);
  const part=(type:string)=>parts.find(x=>x.type===type)?.value||"";
  return {
    day:`${part("year")}-${part("month")}-${part("day")}`,
    hour:Number(part("hour")),
  };
}
