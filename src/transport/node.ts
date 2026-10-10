import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { readConfiguration } from "../infra/config.js";
import { LocalStore } from "../infra/node-store.js";
import { createHttpApp } from "../server/http.js";
const root=path.resolve(process.env.TRADEPILOT_ROOT??process.cwd());
dotenv.config({path:path.join(root,".env.local"),quiet:true});
dotenv.config({path:path.join(root,".env"),quiet:true});
const port=Number(process.env.PORT||8080);
const config=readConfiguration(process.env,`http://localhost:${port}`);
const state=await LocalStore.open(path.join(root,".data","insight-v3.json"));
const app=createHttpApp({
  config,state,
  widgetHtml:()=>fs.readFile(path.join(root,"dist","widget","index.html"),"utf8"),
});
serve({fetch:app.fetch,port,hostname:"127.0.0.1"},()=>{
  console.log(`TradePilot Insight V3 listening on http://127.0.0.1:${port}`);
});
