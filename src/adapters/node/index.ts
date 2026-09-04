import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createApp } from "../../app/create-app.js";
import { createConfig } from "../../core/config.js";
import { FileStateStore } from "./file-state-store.js";

const root = path.resolve(process.env.TRADEPILOT_ROOT ?? process.cwd());
dotenv.config({ path: path.join(root, ".env.local"), quiet: true }); dotenv.config({ path: path.join(root, ".env"), quiet: true });
const port = Number(process.env.PORT ?? 8000), config = createConfig(process.env, process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
const store = await FileStateStore.open(path.join(root, ".data", "state.json"));
const audit = async (event: string, details: Record<string, unknown>) => { try { const dir = path.join(root, ".data"); await fs.mkdir(dir,{recursive:true}); await fs.appendFile(path.join(dir,"audit.jsonl"),`${JSON.stringify({ts:new Date().toISOString(),event,...details})}\n`); } catch (error) { console.error("Audit write failed", error); } };
const app = createApp({ config, store, widgetHtml: () => fs.readFile(path.join(root,"dist","widget","index.html"),"utf8"), audit });
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`TradePilot 212 listening on http://localhost:${port}`));
