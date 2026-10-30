import { it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";

async function connect(scopes?: Set<string>, env: Record<string,string> = {}) {
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createMcpServer } = await import("./mcp.js");
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true", ...env } as RuntimeEnv);
  const services = createServices({ config, store: new MemoryStateStore() });
  const server = createMcpServer(services, config, async () => "<html></html>", scopes);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, services };
}
it("dump", async () => {
  const { client } = await connect(new Set(["trade:read"]));
  console.log("CAPS", JSON.stringify(client.getServerCapabilities()));
  console.log("LIST", JSON.stringify((await client.listResources()).resources.map(r => r.uri)));
  const h = (await client.readResource({ uri: "tradepilot://demo/holdings" })).contents[0] as any;
  const parsed = JSON.parse(h.text);
  console.log("HOLDKEYS", Object.keys(parsed), JSON.stringify(parsed.account));
  const live = (await client.readResource({ uri: "tradepilot://live/holdings" })).contents[0] as any;
  console.log("LIVE", live.text);
  for (const v of ["", "DEMO", "Demo"]) {
    try { console.log("ENV", JSON.stringify(v), JSON.stringify((await client.complete({ ref: { type: "ref/prompt", name: "rebalance" }, argument: { name: "environment", value: v } })).completion)); } catch (e) { console.log("ENVERR", String(e)); }
  }
  try { console.log("INSTR-DEMO-UPPER", JSON.stringify((await client.complete({ ref: { type: "ref/prompt", name: "trade-journal" }, argument: { name: "instrument", value: "" }, context: { arguments: { environment: "DEMO" } } })).completion)); } catch (e) { console.log("ERR", String(e)); }
  try { const p = await client.getPrompt({ name: "rebalance", arguments: { environment: "DEMO" } }); console.log("PROMPT-UPPER ok", (p.messages[0]!.content as any).text.slice(0,80)); } catch (e) { console.log("PROMPT-UPPER ERR", String(e)); }
  try { const p = await client.getPrompt({ name: "rebalance", arguments: { environment: "live" } }); console.log("PROMPT-LIVE ok", (p.messages[0]!.content as any).text.slice(0,120)); } catch (e) { console.log("PROMPT-LIVE ERR", String(e)); }
  try { const p = await client.getPrompt({ name: "rebalance", arguments: {} }); console.log("PROMPT-NOARGS ok", (p.messages[0]!.content as any).text.slice(0,120)); } catch (e) { console.log("PROMPT-NOARGS ERR", String(e)); }
  try { const p = await client.getPrompt({ name: "rebalance" } as any); console.log("PROMPT-UNDEF ok", (p.messages[0]!.content as any).text.slice(0,120)); } catch (e) { console.log("PROMPT-UNDEF ERR", String(e)); }
  console.log("PROMPTS", JSON.stringify((await client.listPrompts()).prompts.find(p=>p.name==="order-followup")));
  const tools = (await client.listTools()).tools.map(t=>t.name);
  console.log("TOOLS", tools.length, tools.filter(t=>/cancel|execute|prepare|review_|rebalance/.test(t)));
});
