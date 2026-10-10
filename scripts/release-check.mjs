import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const ignored=new Set([".git","node_modules","dist",".data",".wrangler","coverage"]);
function files(folder,output=[]){
  for(const item of fs.readdirSync(folder,{withFileTypes:true})){
    if(ignored.has(item.name))continue;
    const full=path.join(folder,item.name);
    if(item.isDirectory())files(full,output);
    else output.push(full);
  }return output;
}
const tracked=spawnSync("git",["ls-files","-z"],{encoding:"utf8"});
const paths=(tracked.stdout||"").split("\0").filter(Boolean);
for(const file of paths){
  if([".env",".env.local",".dev.vars","worker-configuration.d.ts"].includes(path.basename(file)) || file.startsWith(".data/"))
    throw new Error(`Private data is Git tracked: ${file}`);
}
const broker=fs.readFileSync(path.join(root,"src/infra/broker.ts"),"utf8");
if(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(broker) ||
   /\/equity\/orders\/(market|limit|stop)/.test(broker) ||
   /cancelOrder|placeOrder/.test(broker))
  throw new Error("Trading 212 read-only adapter appears to contain a write pathway");
const releaseText=files(root).filter(p=>/\.(ts|tsx|mjs|md|yml|yaml|json|css)$/.test(p));
const example=fs.existsSync(path.join(root,".env.local"))?fs.readFileSync(path.join(root,".env.local"),"utf8"):"";
for(const secretName of ["OWNER_PASSWORD","JWT_SIGNING_SECRET","T212_DEMO_KEY","T212_DEMO_SECRET","T212_LIVE_KEY","T212_LIVE_SECRET"]){
  const value=new RegExp(`^${secretName}=(.+)$`,"m").exec(example)?.[1];
  if(!value||value.length<16)continue;
  for(const file of releaseText){
    if(path.basename(file)===".env.local"||path.basename(file)===".dev.vars")continue;
    if(fs.readFileSync(file,"utf8").includes(value))
      throw new Error(`Release leak prevention triggered in ${path.relative(root,file)}`);
  }
}
console.log("RELEASE_CHECK_OK no secrets tracked and broker adapter statically limited to GET");
