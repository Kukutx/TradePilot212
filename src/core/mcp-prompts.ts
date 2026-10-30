// The skills as MCP prompts, and the account's saved state as resources a host can attach: each prompt gives the
// skill's steps with the account and request filled in, and each resource is one JSON document per account. The
// environment and instrument arguments complete from what the account has.

import { completable, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import { SKILL_PROMPTS } from "./skill-prompts.js";
import type { Services } from "../app/services.js";
import type { TradingEnvironment } from "../shared/contracts.js";

const ENVIRONMENTS = ["demo", "live"] as const;
/** At most this many instruments are offered while one is typed. */
export const MAX_COMPLETIONS = 20;

const TITLES: Record<string, string> = {
  "daily-brief": "Daily brief",
  "order-followup": "Order follow-up",
  "portfolio-review": "Portfolio review",
  rebalance: "Rebalance",
  "risk-check": "Risk check",
  "tax-year": "Tax year",
  "trade-journal": "Trade journal",
};
/** The prompts about one instrument take it as an argument. */
const ABOUT_INSTRUMENT = new Set(["order-followup", "trade-journal"]);

type PromptDeps = Pick<Services, "trading" | "journal" | "targets" | "watchlist">;

export function registerPromptsAndResources(server: McpServer, { trading, journal, targets, watchlist }: PromptDeps, config: RuntimeConfig): void {
  const environmentOf = (value: string | undefined): TradingEnvironment => {
    if (value === undefined || value === "") return config.defaultTradingEnvironment;
    if (value === "demo" || value === "live") return value;
    throw new Error(`Unknown account "${value}": use demo or live`);
  };
  const environments = (value: string) => ENVIRONMENTS.filter((environment) => environment.startsWith(value.toLowerCase()));
  /** The tickers held, ordered or watched on the account that start with what is typed; none when it cannot be read. */
  const instruments = async (value: string, environment: TradingEnvironment) => {
    if (!credentialStatus(config)[environment]) return [];
    const [dashboard, watched] = await Promise.all([trading.getDashboard(environment, 60_000).catch(() => undefined), watchlist.list(environment).catch(() => [])]);
    const tickers = [
      ...(dashboard?.positions ?? []).map((position) => position.instrument?.ticker),
      ...(dashboard?.orders ?? []).map((order) => order.ticker),
      ...watched.map((item) => item.ticker),
    ].filter((ticker): ticker is string => typeof ticker === "string" && ticker !== "");
    const typed = value.toLowerCase();
    return [...new Set(tickers)].filter((ticker) => ticker.toLowerCase().startsWith(typed)).slice(0, MAX_COMPLETIONS);
  };

  for (const skill of SKILL_PROMPTS) {
    const about = ABOUT_INSTRUMENT.has(skill.name);
    const argsSchema = z.object({
      // Completable inside optional: the SDK looks for the completion under the optional.
      environment: completable(z.string().describe("demo or live; this server's default when left out."), (value) => environments(value)).optional(),
      ...(about ? { instrument: completable(z.string().describe("The instrument, as a ticker or name."), (value, context) => {
        const environment = context?.arguments?.environment;
        return environment === undefined || environment === "demo" || environment === "live" ? instruments(value, environmentOf(environment)) : [];
      }).optional() } : {}),
      request: z.string().optional().describe("What the user asked, in their words."),
    });
    server.registerPrompt(skill.name, { title: TITLES[skill.name] ?? skill.name, description: skill.description, argsSchema }, (args) => {
      const { environment, instrument, request } = args as { environment?: string; instrument?: string; request?: string };
      const lines = [
        `Follow the TradePilot steps below on the ${environmentOf(environment).toUpperCase()} Trading 212 account.`,
        instrument ? `The instrument: ${instrument}.` : "",
        request ? `The user asked: ${request}` : "",
      ].filter(Boolean);
      return { description: skill.description, messages: [{ role: "user" as const, content: { type: "text" as const, text: `${lines.join("\n")}\n\n${skill.body}` } }] };
    });
  }

  /** One JSON document per account, listed for the accounts with keys. */
  const perAccount = (name: string, title: string, description: string, read: (environment: TradingEnvironment) => Promise<unknown>) => {
    const template = new ResourceTemplate(`tradepilot://{environment}/${name}`, {
      list: async () => ({
        resources: ENVIRONMENTS.filter((environment) => credentialStatus(config)[environment]).map((environment) => ({
          uri: `tradepilot://${environment}/${name}`, name: `${environment}-${name}`, title: `${title} (${environment.toUpperCase()})`, mimeType: "application/json",
        })),
      }),
      complete: { environment: environments },
    });
    server.registerResource(name, template, { title, description, mimeType: "application/json" }, async (uri, variables) => {
      const value = String(variables.environment ?? "");
      if (value !== "demo" && value !== "live") throw new Error(`Unknown account "${value}": use demo or live`);
      const data = await read(value);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    });
  };
  perAccount("holdings", "Holdings", "The account summary, holdings and open orders as Trading 212 gives them, read at most a minute ago.", async (environment) => {
    const { kind: _kind, appName: _appName, activity: _activity, credentials: _credentials, ...snapshot } = await trading.getDashboard(environment, 60_000);
    return snapshot;
  });
  perAccount("journal", "Trade journal", "Every trade journal note on the account: the reason for a trade, any look back and its tags.", async (environment) => ({ environment, entries: await journal.list(environment) }));
  perAccount("targets", "Target allocation", "The saved target weights, cash share and drift threshold; null when none are saved.", async (environment) => ({ environment, targets: (await targets.get(environment)) ?? null }));
  perAccount("watchlist", "Watchlist", "The watched instruments, each with the user's note and the price when it was added.", async (environment) => ({ environment, items: await watchlist.list(environment) }));
}
