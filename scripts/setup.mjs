import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const target=path.join(root,".env.local");
const example=path.join(root,".env.example");
if(fs.existsSync(target)){
  console.log(".env.local already exists. Nothing was overwritten.");
  process.exit(0);
}
if(!fs.existsSync(example))throw new Error("Run setup from the project root");
let content=fs.readFileSync(example,"utf8");
content=content.replace(/^OWNER_PASSWORD=.*$/m,`OWNER_PASSWORD=${randomBytes(32).toString("base64url")}`);
content=content.replace(/^JWT_SIGNING_SECRET=.*$/m,`JWT_SIGNING_SECRET=${randomBytes(64).toString("base64url")}`);
fs.writeFileSync(target,content,{mode:0o600,flag:"wx"});
console.log("Created private .env.local with independent strong owner credentials.");
console.log("Default source is SYNTHETIC SAMPLE. Set DATA_SOURCE=trading212 and read-only keys if needed.");
console.log("Next: pnpm doctor && pnpm check && pnpm dev");
