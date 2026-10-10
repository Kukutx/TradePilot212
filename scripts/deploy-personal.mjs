import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root=process.cwd();
dotenv.config({path:path.join(root,".env.local"),quiet:true});
dotenv.config({path:path.join(root,".env"),quiet:true});
const dryRun=process.argv.includes("--dry-run");
const named=process.argv.find(x=>x.startsWith("--name="))?.split("=")[1];
const workerName=named||"tradepilot212-personal-v3";
if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName))throw new Error("Invalid Worker name");
function run(args,input){
  const command=process.platform==="win32"?"pnpm.cmd":"pnpm";
  const response=spawnSync(command,args,{
    cwd:root,stdio:input===undefined?"inherit":["pipe","inherit","inherit"],
    input,encoding:"utf8",shell:false,
  });
  if(response.error)throw response.error;
  if(response.status!==0)throw new Error(`Command failed (exit ${response.status}): pnpm ${args.join(" ")}`);
}
if(!fs.existsSync(path.join(root,".env.local")))
  throw new Error("Run pnpm setup and configure your private deployment first");
const origin=process.env.PUBLIC_ORIGIN||"";
if(!dryRun && (!origin.startsWith("https://")||new URL(origin).origin!==origin))
  throw new Error("Public Worker deployment requires exact HTTPS PUBLIC_ORIGIN");
run(["doctor"]);
run(["check"]);
run(["release:check"]);
console.log("Validating Cloudflare deployment without publishing...");
run(["exec","wrangler","deploy","--dry-run","--name",workerName]);
if(dryRun){console.log("DRY_RUN_OK — no Cloudflare secrets or deployment were changed");process.exit(0);}
console.log("Syncing new V3 personal environment secrets. Broker actions remain disabled unless explicitly opted in.");
const secretNames=[
  "PUBLIC_ORIGIN","OWNER_PASSWORD","JWT_SIGNING_SECRET","OAUTH_CLIENT_ORIGINS",
  "DATA_SOURCE","DEFAULT_ENVIRONMENT",
  "T212_DEMO_KEY","T212_DEMO_SECRET","T212_LIVE_KEY","T212_LIVE_SECRET",
  "PERSONAL_TRADING_ENABLED","PERSONAL_LIVE_TRADING_ENABLED","PERSONAL_APPROVAL_SECRET",
  "PERSONAL_MAX_NOTIONAL","PERSONAL_MAX_QUANTITY","PERSONAL_CONFIRMATION_TTL",
];
const secrets=Object.fromEntries(secretNames.map(name=>[name,process.env[name]??""]));
if(!secrets.OWNER_PASSWORD||!secrets.JWT_SIGNING_SECRET)throw new Error("Missing owner authentication");
run(["exec","wrangler","secret","bulk","--name",workerName],JSON.stringify(secrets));
run(["exec","wrangler","deploy","--name",workerName]);
console.log(`Deployment submitted for ${workerName}. Connect your own /mcp endpoint using the HTTPS PUBLIC_ORIGIN.`);
console.log("Never share an instance containing personal Trading 212 credentials as a public multi-user plugin.");
