import {describe,expect,it,vi} from "vitest";
import type {BrokerReader} from "../infra/broker.js";
import {readConfiguration} from "../infra/config.js";
import {MemoryStore} from "../infra/state.js";
import type {Notifier} from "../infra/notification.js";
import {defaultPreferences,OwnerPreferencesStore,zonedHourAndDate} from "../domain/preferences.js";
import {IntelligenceService} from "./intelligence.js";
import {DailyAutomation} from "./daily-automation.js";

const auth={
  PUBLIC_ORIGIN:"https://personal.example.test",
  OWNER_PASSWORD:"owner-password-length-at-least-24",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  DATA_SOURCE:"trading212",
  T212_DEMO_KEY:"mock",T212_DEMO_SECRET:"mock-secret",
} as const;
function make(){
  const config=readConfiguration(auth),store=new MemoryStore();
  const getPortfolio=vi.fn(async(environment:"demo"|"live")=>({
    kind:"portfolio" as const,environment,source:"trading212" as const,asOf:new Date().toISOString(),
    account:{currency:"USD",totalValue:1000,availableCash:100,investmentValue:900,unrealizedProfitLoss:-110},
    holdings:[{ticker:"EXAMPLE_US_EQ",name:"Example",currency:"USD",quantity:9,
      tradableQuantity:9,price:100,valueInAccountCurrency:900,valueProvenance:"same_currency_quote" as const}],
    notes:[],
  }));
  const broker:BrokerReader={getPortfolio,async getRecentOrders(){return {items:[],nextCursor:null};}};
  const service=new IntelligenceService(config,store,broker);
  const notify=vi.fn(async()=>({sent:true,provider:"test"}));
  const notifier:Notifier={configured:()=>true,send:notify};
  let now=new Date();
  const hour=zonedHourAndDate(now,"Europe/Rome").hour;
  const run=new DailyAutomation(config,store,service,notifier,()=>now);
  return {run,store,service,getPortfolio,notify,hour,setDate:(next:Date)=>{now=next;},today:now};
}
describe("owner-scheduled read-only daily intelligence",()=>{
  it("never sends or fetches brokerage data when owner has not opted in",async()=>{
    const {run,getPortfolio,notify}=make();
    expect((await run.run("demo")).status).toBe("skipped");
    expect(getPortfolio).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("runs at chosen local hour, stores reports and deduplicates sends",async()=>{
    const {run,store,service,notify,hour}=make();
    const prefs=new OwnerPreferencesStore(store);
    await prefs.save({...defaultPreferences(),timezone:"Europe/Rome",
      dailyBrief:{enabled:true,hour,onlyOnChange:true,includeLive:false,email:true}});
    await service.enableBasicMonitoring("demo");
    const first=await run.run("demo");
    expect(first.status).toBe("complete");
    if(first.status==="complete"){
      expect(first.report.reviewCount).toBeGreaterThan(0);
      expect(first.report.notification).toBe("sent");
      expect(first.report.brokerWrites).toBe(0);
      expect(first.report.source).toBe("trading212");
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await run.run("demo")).status).toBe("skipped");
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await run.run("live")).status).toBe("skipped");
    const report=await store.list("v3:daily-report:demo:");
    expect(report).toHaveLength(1);
  });
  it("only sends again on significant new changes, not on every observation",async()=>{
    const {run,store,notify,hour,setDate,today}=make();
    await new OwnerPreferencesStore(store).save({...defaultPreferences(),timezone:"Europe/Rome",
      dailyBrief:{enabled:true,hour,onlyOnChange:true,includeLive:false,email:true}});
    expect((await run.run("demo")).status).toBe("complete");
    const later=new Date(today.getTime()+86400_000);
    setDate(later);
    const again=await run.run("demo");
    expect(again.status).toBe("complete");
    if(again.status==="complete")expect(again.report.notification).toBe("unchanged");
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
