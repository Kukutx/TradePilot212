import { SAMPLE_BASE_URL } from "./sample-broker.js";
import type { CredentialStatus, TradingEnvironment } from "../shared/contracts.js";
import type { TradingPolicy } from "../shared/automation.js";
import { parseSymbolMap, QUOTE_PROVIDERS, type QuoteProviderName } from "./quotes.js";
import { fail } from "./errors.js";

/** `URL.hostname` keeps the brackets around an IPv6 address, so both spellings are accepted. */
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

export interface RuntimeConfig {
  publicBaseUrl: string;
  loginPassword: string;
  signingSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  confirmationTtlSeconds: number;
  maxOrderNotional: number;
  maxOrderQuantity: number;
  defaultTradingEnvironment: TradingEnvironment;
  policy: Record<TradingEnvironment, TradingPolicy>;
  /** Lets due Demo plans and Demo trailing stops place orders without a person (L3). Live never does. */
  demoAutomationEnabled: boolean;
  /** Cancel the other half of a stop-loss / take-profit pair once one fills (default on). */
  protectiveLinking: boolean;
  /** Optional HTTPS endpoint that receives a JSON message for notable automation events. */
  notifyWebhookUrl: string;
  /** Optional secret; when set each webhook carries an HMAC-SHA256 signature header. */
  notifyWebhookSecret: string;
  /** Activity types sent to the webhook; empty means the default set in notify.ts. */
  notifyEvents: string[];
  /** External quote source for instruments you do not hold (Trading 212 has no quote endpoint). */
  quoteProvider: QuoteProviderName;
  quoteApiKey: string;
  /** Exact Trading 212 ticker to provider symbol, for instruments outside the US. */
  quoteSymbols: Map<string, string>;
  /** UTC hour of the daily webhook digest; undefined turns it off. */
  digestHourUtc?: number;
  /** Serve a simulated Demo account instead of Trading 212 (TRADEPILOT_SAMPLE_DATA). Live is off. */
  sampleData: boolean;
  /** OAuth redirect hosts clients may register (OAUTH_REDIRECT_HOSTS); empty allows any HTTPS host. Loopback is always allowed. */
  oauthRedirectHosts: string[];
  trading212: Record<TradingEnvironment, { baseUrl: string; apiKey: string; apiSecret: string }>;
}

export type RuntimeEnv = Partial<Record<
  | "PUBLIC_BASE_URL" | "APP_LOGIN_PASSWORD" | "AUTH_SIGNING_SECRET"
  | "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_SECONDS" | "CONFIRMATION_TTL_SECONDS"
  | "MAX_ORDER_NOTIONAL" | "MAX_ORDER_QUANTITY" | "DEFAULT_TRADING_ENV"
  | "T212_DEMO_API_KEY" | "T212_DEMO_API_SECRET" | "T212_LIVE_API_KEY" | "T212_LIVE_API_SECRET"
  | "POLICY_MAX_POSITION_WEIGHT" | "POLICY_DAILY_ORDER_LIMIT" | "POLICY_DAILY_NOTIONAL_LIMIT"
  | "POLICY_ALLOWED_TICKERS" | "POLICY_BLOCKED_TICKERS" | "POLICY_ALLOWED_TYPES"
  | "POLICY_MARKET_ORDERS_WHEN_CLOSED" | "POLICY_MAX_REFERENCE_AGE_SECONDS" | "POLICY_APPLY_TO"
  | "AUTOMATION_DEMO_ENABLED" | "PROTECTIVE_OCO"
  | "NOTIFY_WEBHOOK_URL" | "NOTIFY_WEBHOOK_SECRET" | "NOTIFY_EVENTS"
  | "QUOTE_PROVIDER" | "QUOTE_API_KEY" | "QUOTE_SYMBOLS" | "DIGEST_HOUR_UTC" | "TRADEPILOT_SAMPLE_DATA"
  | "OAUTH_REDIRECT_HOSTS",
  string
>>;

function positive(env: RuntimeEnv, name: keyof RuntimeEnv, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function nonNegative(env: RuntimeEnv, name: keyof RuntimeEnv, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or a positive number`);
  return value;
}

function tradingEnvironment(env: RuntimeEnv): TradingEnvironment {
  const value = (env.DEFAULT_TRADING_ENV || "demo").trim().toLowerCase();
  if (value !== "demo" && value !== "live") throw new Error("DEFAULT_TRADING_ENV must be demo or live");
  return value;
}

function list(env: RuntimeEnv, name: keyof RuntimeEnv): string[] {
  return (env[name] ?? "").split(/[\s,]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
}

function flag(env: RuntimeEnv, name: keyof RuntimeEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env[name] ?? "");
}

function weight(env: RuntimeEnv, name: keyof RuntimeEnv, fallback: number): number {
  const value = nonNegative(env, name, fallback);
  if (value > 1) throw new Error(`${name} must be a fraction between 0 and 1`);
  return value;
}

/**
 * Policy rules come from POLICY_* variables. POLICY_APPLY_TO chooses which environments they
 * bind (default "live"); the other environment keeps only the built-in safety checks.
 */
function createPolicy(env: RuntimeEnv): Record<TradingEnvironment, TradingPolicy> {
  const configured: TradingPolicy = {
    maxPositionWeight: weight(env, "POLICY_MAX_POSITION_WEIGHT", 0.25),
    dailyOrderLimit: Math.floor(nonNegative(env, "POLICY_DAILY_ORDER_LIMIT", 20)),
    dailyNotionalLimit: nonNegative(env, "POLICY_DAILY_NOTIONAL_LIMIT", 0),
    allowedTickers: list(env, "POLICY_ALLOWED_TICKERS"),
    blockedTickers: list(env, "POLICY_BLOCKED_TICKERS"),
    allowedTypes: list(env, "POLICY_ALLOWED_TYPES"),
    marketOrdersWhenClosed: env.POLICY_MARKET_ORDERS_WHEN_CLOSED ? flag(env, "POLICY_MARKET_ORDERS_WHEN_CLOSED") : false,
    maxReferenceAgeSeconds: Math.floor(nonNegative(env, "POLICY_MAX_REFERENCE_AGE_SECONDS", 0)),
  };
  const relaxed: TradingPolicy = { ...configured, maxPositionWeight: 0, dailyOrderLimit: 0, dailyNotionalLimit: 0, allowedTickers: [], blockedTickers: [], allowedTypes: [], marketOrdersWhenClosed: true, maxReferenceAgeSeconds: 0 };
  const applyTo = (env.POLICY_APPLY_TO || "live").trim().toLowerCase();
  if (!["live", "demo", "both", "none"].includes(applyTo)) throw new Error("POLICY_APPLY_TO must be live, demo, both, or none");
  return {
    demo: applyTo === "demo" || applyTo === "both" ? configured : relaxed,
    live: applyTo === "live" || applyTo === "both" ? configured : relaxed,
  };
}

function webhookUrl(env: RuntimeEnv): string {
  const raw = (env.NOTIFY_WEBHOOK_URL ?? "").trim();
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(isLoopbackHost(url.hostname) && url.protocol === "http:")) throw new Error("NOTIFY_WEBHOOK_URL must use HTTPS");
  return url.toString();
}

function digestHour(env: RuntimeEnv): number | undefined {
  const raw = (env.DIGEST_HOUR_UTC ?? "").trim();
  if (!raw) return undefined;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("DIGEST_HOUR_UTC must be an integer from 0 to 23");
  return hour;
}

function quoteProvider(env: RuntimeEnv): QuoteProviderName {
  const value = (env.QUOTE_PROVIDER || "stooq").trim().toLowerCase() as QuoteProviderName;
  if (!QUOTE_PROVIDERS.includes(value)) throw new Error(`QUOTE_PROVIDER must be one of ${QUOTE_PROVIDERS.join(", ")}`);
  return value;
}

export function createConfig(env: RuntimeEnv, requestOrigin?: string): RuntimeConfig {
  const publicBaseUrl = (env.PUBLIC_BASE_URL || requestOrigin || "http://localhost:8000").replace(/\/+$/, "");
  const policy = createPolicy(env);
  const sampleData = flag(env, "TRADEPILOT_SAMPLE_DATA");
  return {
    publicBaseUrl,
    loginPassword: env.APP_LOGIN_PASSWORD ?? "",
    signingSecret: env.AUTH_SIGNING_SECRET ?? "",
    accessTokenTtlSeconds: Math.floor(positive(env, "ACCESS_TOKEN_TTL_SECONDS", 3600)),
    refreshTokenTtlSeconds: Math.floor(positive(env, "REFRESH_TOKEN_TTL_SECONDS", 30 * 86400)),
    confirmationTtlSeconds: Math.floor(positive(env, "CONFIRMATION_TTL_SECONDS", 90)),
    maxOrderNotional: nonNegative(env, "MAX_ORDER_NOTIONAL", 5000),
    maxOrderQuantity: nonNegative(env, "MAX_ORDER_QUANTITY", 100000),
    defaultTradingEnvironment: sampleData ? "demo" : tradingEnvironment(env),
    policy,
    demoAutomationEnabled: flag(env, "AUTOMATION_DEMO_ENABLED"),
    protectiveLinking: env.PROTECTIVE_OCO ? flag(env, "PROTECTIVE_OCO") : true,
    notifyWebhookUrl: webhookUrl(env),
    notifyWebhookSecret: env.NOTIFY_WEBHOOK_SECRET ?? "",
    notifyEvents: list(env, "NOTIFY_EVENTS").map((item) => item.toLowerCase()),
    quoteProvider: sampleData ? "none" : quoteProvider(env),
    quoteApiKey: env.QUOTE_API_KEY ?? "",
    quoteSymbols: parseSymbolMap(env.QUOTE_SYMBOLS ?? ""),
    ...(digestHour(env) === undefined ? {} : { digestHourUtc: digestHour(env)! }),
    sampleData,
    oauthRedirectHosts: list(env, "OAUTH_REDIRECT_HOSTS").map((item) => item.toLowerCase()),
    // Sample data never reaches Trading 212: Demo points at the simulated account and Live has no keys.
    trading212: sampleData
      ? {
          demo: { baseUrl: SAMPLE_BASE_URL, apiKey: "sample", apiSecret: "sample" },
          live: { baseUrl: "https://live.trading212.com/api/v0", apiKey: "", apiSecret: "" },
        }
      : {
          demo: { baseUrl: "https://demo.trading212.com/api/v0", apiKey: env.T212_DEMO_API_KEY ?? "", apiSecret: env.T212_DEMO_API_SECRET ?? "" },
          live: { baseUrl: "https://live.trading212.com/api/v0", apiKey: env.T212_LIVE_API_KEY ?? "", apiSecret: env.T212_LIVE_API_SECRET ?? "" },
        },
  };
}

export function credentialStatus(config: RuntimeConfig): CredentialStatus {
  return {
    demo: Boolean(config.trading212.demo.apiKey && config.trading212.demo.apiSecret),
    live: Boolean(config.trading212.live.apiKey && config.trading212.live.apiSecret),
    ...(config.sampleData ? { sample: true } : {}),
  };
}

/** Stops when an environment has no API key. The error names the environment and which ones are set up, so the widget can show the right setup card and offer the other one. */
export function requireCredentials(config: RuntimeConfig, environment: TradingEnvironment): void {
  const status = credentialStatus(config);
  if (!status[environment]) fail("CREDENTIALS_NOT_CONFIGURED", `${environment.toUpperCase()} credentials are not configured`, { environment, demo: status.demo, live: status.live });
}

export function assertAuthConfigured(config: RuntimeConfig): void {
  if (!config.loginPassword || config.loginPassword === "change-this-password" || config.loginPassword.length < 16)
    throw new Error("APP_LOGIN_PASSWORD must be a non-placeholder value with at least 16 characters");
  if (config.signingSecret.length < 32 || config.signingSecret.startsWith("change-this-"))
    throw new Error("AUTH_SIGNING_SECRET must be a non-placeholder value with at least 32 characters");
  const url = new URL(config.publicBaseUrl);
  if (!isLoopbackHost(url.hostname) && url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS outside localhost");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("PUBLIC_BASE_URL must be an origin without credentials, query, fragment, or path");
}

