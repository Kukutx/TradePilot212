import {spawn,spawnSync} from "node:child_process";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
dotenv.config({path:".env.local",quiet:true});
dotenv.config({path:".env",quiet:true});
if(!process.env.OWNER_PASSWORD||!process.env.JWT_SIGNING_SECRET)
  throw new Error("Run pnpm setup before starting a temporary HTTPS tunnel");
const port=Number(process.env.PORT||8080);
const command=process.platform==="win32"?"pnpm.cmd":"pnpm";
const build=spawnSync(command,["build:widget"],{stdio:"inherit",shell:false});
if(build.status!==0)throw new Error("Widget build failed");
console.log("Starting an ephemeral Cloudflare quick tunnel. It is NOT a long-term private server.");
const tunnel=spawn("cloudflared",["tunnel","--url",`http://127.0.0.1:${port}`,"--no-autoupdate"],{stdio:["ignore","pipe","pipe"],shell:false});
let server=null,started=false;
const urlPattern=/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
function onData(bytes){
  const output=String(bytes);
  process.stdout.write(output);
  if(started)return;
  const url=output.match(urlPattern)?.[0];
  if(!url)return;
  started=true;
  console.log(`\nV3 PERSONAL MCP: ${url}/mcp\nKeep OWNER_PASSWORD private. Do not paste it into ChatGPT/Claude messages.\n`);
  server=spawn(process.execPath,[path.join(process.cwd(),"node_modules","tsx","dist","cli.mjs"),"src/transport/node.ts"],{
    cwd:process.cwd(),stdio:"inherit",shell:false,
    env:{...process.env,PUBLIC_ORIGIN:url,PORT:String(port)},
  });
  server.on("exit",code=>{if(tunnel.exitCode===null)tunnel.kill();process.exitCode=code??1;});
}
tunnel.stdout.on("data",onData);tunnel.stderr.on("data",onData);
tunnel.on("error",error=>console.error("cloudflared missing or could not start:",error.message));
tunnel.on("exit",code=>{if(!started)console.error("Tunnel failed before it provided an HTTPS URL");if(server?.exitCode===null)server.kill();process.exitCode=code??1;});
function shutdown(){if(server?.exitCode===null)server.kill();if(tunnel.exitCode===null)tunnel.kill();}
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
