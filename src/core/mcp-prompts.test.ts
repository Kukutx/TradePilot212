import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { parseSkill } from "./skill-parse.js";
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
    const written = await Promise.all(names.map(async (name) => parseSkill(name, await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8"))));
    expect(SKILL_PROMPTS).toEqual(written);
  });

  it("refuse front matter a YAML loader would read differently", () => {
    expect(() => parseSkill("x", "---\nname: x\ndescription: >-\n  Folded\n---\nBody")).toThrow(/plain text on one line/);
    expect(() => parseSkill("x", "---\nname: x\ndescription: \"Quoted\"\n---\nBody")).toThrow(/plain text on one line/);
    expect(() => parseSkill("x", "---\nname: x\ndescription:\n  Next line\n---\nBody")).toThrow(/plain text on one line/);
    expect(parseSkill("x", "---\r\nname: x\r\ndescription: Use it: often\r\n---\r\n\r\n# X\r\n")).toEqual({ name: "x", description: "Use it: often", body: "# X" });
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
    // An empty field is the default account, and the name is read in any case, as the prompt reads them.
    expect(await complete("order-followup", "instrument", "a", { environment: "" })).toContain("AAPL_US_EQ");
    expect(await complete("order-followup", "instrument", "a", { environment: "Demo" })).toContain("AAPL_US_EQ");
    expect(await complete("order-followup", "instrument", "a", { environment: "paper" })).toEqual([]);
    expect(((await client.getPrompt({ name: "risk-check", arguments: { environment: "DEMO" } })).messages[0]!.content as { text: string }).text).toContain("DEMO Trading 212 account");
    await expect(client.getPrompt({ name: "risk-check", arguments: { environment: "paper" } })).rejects.toThrow();
    // No keys for Live on the sample account: nothing to offer.
    expect(await complete("order-followup", "instrument", "", { environment: "live" })).toEqual([]);
  });
});

describe("account resources", () => {
  it("lists each document for the accounts with keys and reads it as JSON", async () => {
    const { client, services } = await connect();
    const listed = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(listed).toEqual(expect.arrayContaining(["tradepilot://demo/holdings", "tradepilot://demo/journal", "tradepilot://demo/targets", "tradepilot://demo/watchlist", "tradepilot://demo/goal"]));
    // No keys for Live on the sample account: nothing for it.
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
    expect(await read("tradepilot://demo/goal")).toEqual({ environment: "demo", goal: null });
    await services.goals.set({ environment: "demo", target: 50_000, by: "2040-12-31", monthly: 100 });
    expect((await read("tradepilot://demo/goal")).goal).toMatchObject({ target: 50_000, by: "2040-12-31", monthly: 100 });
    await expect(client.readResource({ uri: "tradepilot://live/holdings" })).rejects.toThrow();
  });
});
