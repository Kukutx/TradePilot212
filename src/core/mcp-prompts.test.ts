import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { SKILL_PROMPTS } from "./skill-prompts.js";
import { MemoryStateStore } from "./state-store.js";

async function connect() {
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createMcpServer } = await import("./mcp.js");
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" } as RuntimeEnv);
  const services = createServices({ config, store: new MemoryStateStore() });
  const server = createMcpServer(services, config, async () => "<html></html>");
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, services };
}

describe("skill prompts", () => {
  it("carry each skill as it is written in skills/ (run `pnpm build:prompts` after changing one)", async () => {
    const names = (await readdir(new URL("../../skills/", import.meta.url), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(SKILL_PROMPTS.map((prompt) => prompt.name)).toEqual(names);
    for (const prompt of SKILL_PROMPTS) {
      const text = (await readFile(new URL(`../../skills/${prompt.name}/SKILL.md`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
      expect(text.trim().endsWith(prompt.body), prompt.name).toBe(true);
      expect(text).toContain(`description: ${prompt.description}`);
    }
  });

  it("are offered with the account, instrument and request filled in, and complete what the account has", async () => {
    const { client } = await connect();
    const prompts = (await client.listPrompts()).prompts;
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(SKILL_PROMPTS.map((prompt) => prompt.name));
    expect(prompts.find((prompt) => prompt.name === "trade-journal")!.arguments!.map((argument) => argument.name)).toEqual(["environment", "instrument", "request"]);
    expect(prompts.find((prompt) => prompt.name === "risk-check")!.arguments!.map((argument) => argument.name)).toEqual(["environment", "request"]);

    const prompt = await client.getPrompt({ name: "trade-journal", arguments: { environment: "demo", instrument: "AAPL_US_EQ", request: "Why did I buy Apple?" } });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/^Follow the TradePilot steps below on the DEMO Trading 212 account\.\nThe instrument: AAPL_US_EQ\.\nThe user asked: Why did I buy Apple\?/);
    expect(text).toContain("# Trade journal");

    const complete = (name: string, argument: string, value: string, context?: Record<string, string>) =>
      client.complete({ ref: { type: "ref/prompt", name }, argument: { name: argument, value }, ...(context ? { context: { arguments: context } } : {}) }).then((reply) => reply.completion.values);
    expect(await complete("rebalance", "environment", "l")).toEqual(["live"]);
    expect(await complete("order-followup", "instrument", "a", { environment: "demo" })).toContain("AAPL_US_EQ");
    // No keys for Live on the sample account: nothing to offer.
    expect(await complete("order-followup", "instrument", "", { environment: "live" })).toEqual([]);
  });
});

describe("account resources", () => {
  it("lists each document for the accounts with keys and reads it as JSON", async () => {
    const { client, services } = await connect();
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate).sort();
    expect(templates).toEqual(["tradepilot://{environment}/holdings", "tradepilot://{environment}/journal", "tradepilot://{environment}/targets", "tradepilot://{environment}/watchlist"]);
    const listed = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(listed).toEqual(expect.arrayContaining(["tradepilot://demo/holdings", "tradepilot://demo/journal", "tradepilot://demo/targets", "tradepilot://demo/watchlist"]));
    expect(listed.some((uri) => uri.startsWith("tradepilot://live/"))).toBe(false);

    const read = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text) as Record<string, unknown>;
    const holdings = await read("tradepilot://demo/holdings");
    expect(holdings.environment).toBe("demo");
    expect((holdings.positions as unknown[]).length).toBe(5);
    expect(holdings).not.toHaveProperty("activity");
    expect(await read("tradepilot://demo/targets")).toEqual({ environment: "demo", targets: null });
    await services.targets.set("demo", { targets: [{ instrument: "AAPL", weight: 0.5 }] });
    expect(((await read("tradepilot://demo/targets")).targets as { targets: unknown[] }).targets).toEqual([{ ticker: "AAPL_US_EQ", weight: 0.5 }]);
    await services.watchlist.add("demo", "MSFT", "Cloud");
    expect((await read("tradepilot://demo/watchlist")).items).toEqual([expect.objectContaining({ ticker: "MSFT_US_EQ", note: "Cloud" })]);
    expect((await read("tradepilot://demo/journal")).entries).toEqual([]);
    await expect(client.readResource({ uri: "tradepilot://paper/holdings" })).rejects.toThrow();

    const completed = await client.complete({ ref: { type: "ref/resource", uri: "tradepilot://{environment}/holdings" }, argument: { name: "environment", value: "d" } });
    expect(completed.completion.values).toEqual(["demo"]);
  });
});
