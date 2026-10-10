import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { readConfiguration } from "../src/infra/config.js";
const root=process.cwd();
dotenv.config({path:path.join(root,".env.local"),quiet:true});
dotenv.config({path:path.join(root,".env"),quiet:true});
function print(ok:boolean,name:string,detail:string){console.log(`${ok?"✓":"✗"} ${name}: ${detail}`);}
if(!fs.existsSync(path.join(root,".env.local"))){
  print(false,"Private config","Run pnpm setup first");process.exit(1);
}
try{
  const config=readConfiguration(process.env);
  print(true,"OAuth secrets","Configured and checked independently");
  print(true,"Trusted OAuth hosts",config.trustedClientOrigins.join(", "));
  print(true,"Data source",config.source==="sample"?"SYNTHETIC sample — no broker requests":"Trading 212 (GET ONLY)");
  print(true,"Environment",config.defaultEnvironment);
  for(const env of ["demo","live"] as const)
    print(true,`${env} credentials`,config.broker[env].key?"Read pair configured":"Not configured");
  print(true,"Node version",process.version);
  console.log("No brokerage write operation was performed.");
}catch(error){
  print(false,"Configuration",error instanceof Error?error.message:"Invalid configuration");
  process.exitCode=1;
}
