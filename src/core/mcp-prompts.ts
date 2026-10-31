// The skills as MCP prompts, and the account's saved state as resources a host can attach: each prompt gives the
// skill's steps with the account and request filled in, and each resource is one JSON document per account. The
// prompts' environment and instrument arguments complete from what the account has.

import { completable, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import { SKILL_PROMPTS } from "./skill-prompts.js";
import type { Services } from "../app/services.js";
import type { TradingEnvironment } from "../shared/contracts.js";
import { resourceUri, type ResourceName } from "./resource-changes.js";

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

type PromptDeps = Pick<Services, "trading" | "journal" | "targets" | "watchlist" | "goals"> & Partial<Pick<Services, "changes">>;

/**
 * Let the client subscribe to the account's resources: each subscribed one that changes is sent as
 * notifications/resources/updated, and the client reads it again. Only a connection that stays open (stdio) hears of
 * changes; the HTTP server answers each request with a new server, so a subscription there ends with its request.
 */
function subscribeToChanges(server: McpServer, changes: NonNullable<PromptDeps["changes"]>, uris: ReadonlySet<string>): void {
  const subscribed = new Set<string>();
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler("resources/subscribe", async (request) => {
    // Only the resources this server lists: a subscription to anything else would never be told of a change.
    if (uris.has(request.params.uri)) subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });
  const stop = changes.on((uri) => {
    if (subscribed.has(uri)) server.server.sendResourceUpdated({ uri }).catch(() => undefined);
  });
  const closed = server.server.onclose;
  server.server.onclose = () => { stop(); subscribed.clear(); closed?.(); };
}

export function registerPromptsAndResources(server: McpServer, { trading, journal, targets, watchlist, goals, changes }: PromptDeps, config: RuntimeConfig): void {
  /** The account named, in any case; this server's default when none is (a form sends an empty field as ""). */
  const environmentOf = (value: string | undefined): TradingEnvironment => {
    const named = (value ?? "").trim().toLowerCase();
    if (named === "") return config.defaultTradingEnvironment;
    if (named === "demo" || named === "live") return named;
    throw new Error(`Unknown account "${value}": use demo or live`);
  };
  const environments = (value: string) => ENVIRONMENTS.filter((environment) => environment.startsWith(value.trim().toLowerCase()));
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
        try {
          return instruments(value, environmentOf(context?.arguments?.environment));
        } catch {
          return [];
        }
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

  /**
   * One JSON document per account with keys. Fixed addresses rather than a URI template: the accounts are known when
   * the server starts, and a template brings in the SDK's template matcher for nothing.
   */
  const uris = new Set<string>();
  const perAccount = (name: ResourceName, title: string, description: string, read: (environment: TradingEnvironment) => Promise<unknown>) => {
    for (const environment of ENVIRONMENTS.filter((item) => credentialStatus(config)[item])) {
      const uri = resourceUri(environment, name);
      uris.add(uri);
      server.registerResource(`${environment}-${name}`, uri, { title: `${title} (${environment.toUpperCase()})`, description, mimeType: "application/json" }, async () => ({
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await read(environment), null, 2) }],
      }));
    }
  };
  perAccount("holdings", "Holdings", "The account summary, holdings and open orders as Trading 212 gives them, read at most a minute ago.", async (environment) => {
    const { kind: _kind, appName: _appName, activity: _activity, credentials: _credentials, ...snapshot } = await trading.getDashboard(environment, 60_000);
    return snapshot;
  });
  perAccount("journal", "Trade journal", "Every trade journal note on the account: the reason for a trade, any look back and its tags.", async (environment) => ({ environment, entries: await journal.list(environment) }));
  perAccount("targets", "Target allocation", "The saved target weights, cash share and drift threshold; null when none are saved.", async (environment) => ({ environment, targets: (await targets.get(environment)) ?? null }));
  perAccount("goal", "Investment goal", "The saved investment goal: the target, the date, what is added each month, the return and volatility assumed and the milestone reached; null when none is set.", async (environment) => ({ environment, goal: (await goals.get(environment)) ?? null }));
  perAccount("watchlist", "Watchlist", "The watched instruments, each with the user's note and the price when it was added.", async (environment) => ({ environment, items: await watchlist.list(environment) }));
  if (changes && uris.size) subscribeToChanges(server, changes, uris);
}
