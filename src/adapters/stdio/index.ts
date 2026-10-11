// Local stdio transport for Claude Code, Claude Desktop, and other MCP clients that launch a process.
// There is no OAuth here: whoever can start this process already holds the Trading 212 keys in its env.
//
// Writes are off by default. A stdio host may not support MCP Apps, and then the "app-only"
// confirmation tools would be callable by the model directly. Set TRADEPILOT_ALLOW_WRITES=true only
// in a host that renders the TradePilot UI or prompts you before every tool call.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import dotenv from "dotenv";
import { createConfig } from "../../core/config.js";
import { createMcpServer } from "../../core/mcp.js";
import { createServices } from "../../app/services.js";
import { FileStateStore } from "../node/file-state-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.TRADEPILOT_ROOT ?? process.cwd());
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

// stdout carries the MCP protocol; anything else must go to stderr.
const log = (...args: unknown[]) => console.error("[tradepilot212]", ...args);

const dataDir = path.resolve(process.env.TRADEPILOT_DATA_DIR || path.join(os.homedir(), ".tradepilot212"));
const allowWrites = /^(1|true|yes)$/i.test(process.env.TRADEPILOT_ALLOW_WRITES ?? "");
// A plugin host may pass an unset option through as its literal placeholder; treat that as empty.
for (const [key, value] of Object.entries(process.env)) if (value?.startsWith("${user_config.")) process.env[key] = "";
// Unattended Demo runs are order writes, so they also require writes to be enabled here.
const config = { ...createConfig(process.env), ...(allowWrites ? {} : { demoAutomationEnabled: false }) };
const store = await FileStateStore.open(path.join(dataDir, "state.json"));
const audit = async (event: string, details: Record<string, unknown>) => {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(path.join(dataDir, "audit.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`);
  } catch (error) {
    log("Audit write failed", error);
  }
};

const widgetCandidates = [
  process.env.TRADEPILOT_WIDGET_HTML,
  path.join(here, "widget.html"),
  path.join(root, "dist", "widget", "index.html"),
].filter((item): item is string => Boolean(item));

async function widgetHtml(): Promise<string> {
  for (const candidate of widgetCandidates) {
    try { return await fs.readFile(candidate, "utf8"); } catch { /* try the next location */ }
  }
  return "<!doctype html><meta charset=utf-8><p>TradePilot 212 UI is not built. Run <code>pnpm build</code>.</p>";
}

const services = createServices({ config, store, audit });
const scopes = new Set(allowWrites ? ["trade:read", "trade:write"] : ["trade:read"]);
const server = createMcpServer(services, config, widgetHtml, scopes);
await server.connect(new StdioServerTransport());
const tick = () => services.runScheduled().catch((error: unknown) => log("Scheduler tick failed", error));
setInterval(tick, 60_000).unref();
void tick();
log(`ready (writes ${allowWrites ? "enabled" : "disabled"}, state in ${dataDir})`);
