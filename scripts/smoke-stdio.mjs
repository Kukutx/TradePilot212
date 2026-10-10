// Start the bundled stdio server from an empty directory (no node_modules) and check the tool list.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const bundle = path.resolve("plugin/server.mjs");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "tradepilot-stdio-"));
const env = { PATH: process.env.PATH ?? "", TRADEPILOT_DATA_DIR: path.join(work, "data"), TRADEPILOT_ROOT: work };

async function listTools(extraEnv) {
  const child = spawn(process.execPath, [bundle], { cwd: work, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const responses = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) { const message = JSON.parse(line); if (message.id !== undefined) responses.set(message.id, message); }
    }
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const wait = async (id) => {
    for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!responses.has(id)) throw new Error(`No response ${id}. stderr: ${stderr}`);
    return responses.get(id);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (await wait(2)).result.tools.map((tool) => tool.name);
  child.kill();
  return tools;
}

const readOnly = await listTools({});
for (const name of ["get_portfolio_dashboard", "get_portfolio_performance", "analyze_portfolio_allocation", "get_market_hours"])
  if (!readOnly.includes(name)) throw new Error(`Missing read tool ${name}`);
if (readOnly.some((name) => name.startsWith("app_execute") || name.startsWith("review_trading212")))
  throw new Error("Write tools must be absent unless TRADEPILOT_ALLOW_WRITES=true");
const writable = await listTools({ TRADEPILOT_ALLOW_WRITES: "true" });
if (!writable.includes("app_execute_order")) throw new Error("Write tools missing with TRADEPILOT_ALLOW_WRITES=true");
await fs.rm(work, { recursive: true, force: true });
console.log(`STDIO_SMOKE_OK ${readOnly.length} read-only tools, ${writable.length} with writes enabled`);
