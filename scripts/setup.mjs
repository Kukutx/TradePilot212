import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),target=path.join(root,".env.local"),example=path.join(root,".env.example");
if(!fs.existsSync(example))throw new Error("Run setup from the project root");
let content=fs.existsSync(target)?fs.readFileSync(target,"utf8"):fs.readFileSync(example,"utf8");
let changed=false;
for(const [name,length] of [["OWNER_PASSWORD",32],["JWT_SIGNING_SECRET",64],["PERSONAL_APPROVAL_SECRET",48]]){
  const match=new RegExp(`^${name}=(.*)$`,"m");
  const existing=match.exec(content)?.[1]?.trim()||"";
  if(!existing||existing.startsWith("replace-with")){
    const updated=`${name}=${randomBytes(length).toString("base64url")}`;
    content=match.test(content)?content.replace(match,updated):content.trimEnd()+"\n"+updated+"\n";
    changed=true;
  }
}
if(!fs.existsSync(target)){
  fs.writeFileSync(target,content,{mode:0o600,flag:"wx"});
  console.log("Created private .env.local with three independent strong secrets.");
}else if(changed){
  fs.writeFileSync(target,content,{mode:0o600});
  console.log("Filled missing/placeholder V3 secrets while preserving your existing configuration.");
}else console.log("Existing valid local configuration kept unchanged.");
console.log("Trading is disabled by default. To enable DEMO, configure read/write Demo credentials, DATA_SOURCE=trading212, then PERSONAL_TRADING_ENABLED=true.");
console.log("Live additionally requires PERSONAL_LIVE_TRADING_ENABLED=true; manual UI confirmation remains mandatory.");
console.log("Next: pnpm doctor && pnpm check");
