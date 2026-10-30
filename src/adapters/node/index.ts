import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createApp } from "../../app/create-app.js";
import { createServices } from "../../app/services.js";
import { createConfig } from "../../core/config.js";
import { FileStateStore } from "./file-state-store.js";

const root = path.resolve(process.env.TRADEPILOT_ROOT ?? process.cwd());
dotenv.config({ path: path.join(root, ".env.local"), quiet: true }); dotenv.config({ path: path.join(root, ".env"), quiet: true });
const port = Number(process.env.PORT ?? 8000), config = createConfig(process.env, process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
const store = await FileStateStore.open(path.join(root, ".data", "state.json"));
const ledgerStore = await FileStateStore.open(path.join(root, ".data", "ledger.json"));
const audit = async (event: string, details: Record<string, unknown>) => { try { const dir = path.join(root, ".data"); await fs.mkdir(dir,{recursive:true}); await fs.appendFile(path.join(dir,"audit.jsonl"),`${JSON.stringify({ts:new Date().toISOString(),event,...details})}\n`); } catch (error) { console.error("Audit write failed", error); } };
// One set of services for the HTTP handlers and the scheduler, so they share caches and the tick guard.
const scheduler = createServices({ config, store, ledgerStore, audit });
const app = createApp({ config, store, widgetHtml: () => fs.readFile(path.join(root,"dist","widget","index.html"),"utf8"), audit, services: scheduler });
// Scheduler: settles protective pairs, announces due plans and, with AUTOMATION_DEMO_ENABLED=true, runs Demo autoExecute plans.
const tick = () => scheduler.runScheduled().catch((error: unknown) => console.error("Scheduler tick failed", error));
setInterval(tick, 60_000).unref(); void tick();
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`TradePilot 212 listening on http://localhost:${port}`));
