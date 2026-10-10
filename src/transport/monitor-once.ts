import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { Trading212Reader } from "../infra/broker.js";
import { BrokerPacer } from "../infra/broker-pacer.js";
import {createNotifier} from "../infra/notification.js";
import {DailyAutomation} from "../server/daily-automation.js";
import {OwnerPreferencesStore} from "../domain/preferences.js";
import { readConfiguration } from "../infra/config.js";
import { LocalStore } from "../infra/node-store.js";
import { IntelligenceService } from "../server/intelligence.js";
const root=path.resolve(process.cwd());
dotenv.config({path:path.join(root,".env.local"),quiet:true});
const config=readConfiguration(process.env);
const state=await LocalStore.open(path.join(root,".data","insight-v3.json"));
const svc=new IntelligenceService(config,state,new Trading212Reader(config,fetch,new BrokerPacer(state)));
const prefs=await new OwnerPreferencesStore(state,config.defaultEnvironment).get();
if(prefs.dailyBrief.enabled){
  const automation=new DailyAutomation(config,state,svc,createNotifier(config));
  for(const env of ["demo","live"] as const){
    const result=await automation.run(env);
    console.log(env+": "+(result.status==="complete"?
      "read-only daily report stored, notification="+result.report.notification :
      "skipped, "+result.reason));
  }
  process.exit(0);
}
if(config.source==="sample")throw new Error("No scheduled monitoring in synthetic sample mode");
for(const env of ["demo","live"] as const) {
  if(!config.broker[env].key)continue;
  const rules=await svc.listRules(env);
  if(rules.length){
    const report=await svc.scan(env);
    console.log(`${env}: ${report.evaluated.length} rules, ${report.created} local alerts; brokerWrites=0`);
  }
}
