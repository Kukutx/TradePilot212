import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { executionPermitted,readConfiguration } from "../src/infra/config.js";
const root=process.cwd();
dotenv.config({path:path.join(root,".env.local"),quiet:true});
dotenv.config({path:path.join(root,".env"),quiet:true});
function print(ok:boolean,name:string,detail:string){console.log(`${ok?"✓":"✗"} ${name}: ${detail}`);}
if(!fs.existsSync(path.join(root,".env.local"))){
  print(false,"Private config","Run pnpm setup first");process.exit(1);
}
try{
  const config=readConfiguration(process.env);
  print(true,"OAuth secrets","Configured independently");
  print(true,"Trusted OAuth hosts",config.trustedClientOrigins.join(", "));
  print(true,"Data source",config.source==="sample"?"SYNTHETIC sample — no broker writes":"Trading 212");
  print(true,"Default environment",config.defaultEnvironment);
  print(true,"Email notification provider",config.notifications.provider==="resend"?"Resend configured (outgoing email is still owner-opt-in)":"Disabled");
  print(true,"Optional market quotes",config.marketResearch.twelveDataKey?"Twelve Data configured":"Not configured");
  print(true,"Official SEC filings",config.marketResearch.secContact?"SEC contact configured":"Disabled until SEC_CONTACT_EMAIL is set");
  print(true,"Personal execution",config.personalTrading.enabled?"ENABLED with independent approval":"DISABLED (safe default)");
  print(true,"Unquoted/unbounded Live buy exception",config.personalTrading.allowUnquotedLiveBuys?"OWNER OPTED IN — HIGH RISK":"DENIED by default");
  for(const env of ["demo","live"] as const)
    print(true,`${env} credentials and execution`,
      `${config.broker[env].key?"Configured":"Not configured"} / ${executionPermitted(config,env)?"Enabled":"Disabled"}`);
  print(true,"Node",process.version);
  console.log("Doctor performs no brokerage write.");
}catch(error){
  print(false,"Configuration",error instanceof Error?error.message:"Invalid configuration");
  process.exitCode=1;
}
