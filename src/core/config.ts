import type { CredentialStatus, TradingEnvironment } from "../shared/contracts.js";

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
  trading212: Record<TradingEnvironment, { baseUrl: string; apiKey: string; apiSecret: string }>;
}

export type RuntimeEnv = Partial<Record<
  | "PUBLIC_BASE_URL" | "APP_LOGIN_PASSWORD" | "AUTH_SIGNING_SECRET"
  | "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_SECONDS" | "CONFIRMATION_TTL_SECONDS"
  | "MAX_ORDER_NOTIONAL" | "MAX_ORDER_QUANTITY" | "DEFAULT_TRADING_ENV"
  | "T212_DEMO_API_KEY" | "T212_DEMO_API_SECRET" | "T212_LIVE_API_KEY" | "T212_LIVE_API_SECRET",
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
  const value = (env.DEFAULT_TRADING_ENV ?? "demo").trim().toLowerCase();
  if (value !== "demo" && value !== "live") throw new Error("DEFAULT_TRADING_ENV must be demo or live");
  return value;
}

export function createConfig(env: RuntimeEnv, requestOrigin?: string): RuntimeConfig {
  const publicBaseUrl = (env.PUBLIC_BASE_URL || requestOrigin || "http://localhost:8000").replace(/\/+$/, "");
  return {
    publicBaseUrl,
    loginPassword: env.APP_LOGIN_PASSWORD ?? "",
    signingSecret: env.AUTH_SIGNING_SECRET ?? "",
    accessTokenTtlSeconds: Math.floor(positive(env, "ACCESS_TOKEN_TTL_SECONDS", 3600)),
    refreshTokenTtlSeconds: Math.floor(positive(env, "REFRESH_TOKEN_TTL_SECONDS", 30 * 86400)),
    confirmationTtlSeconds: Math.floor(positive(env, "CONFIRMATION_TTL_SECONDS", 90)),
    maxOrderNotional: nonNegative(env, "MAX_ORDER_NOTIONAL", 5000),
    maxOrderQuantity: nonNegative(env, "MAX_ORDER_QUANTITY", 100000),
    defaultTradingEnvironment: tradingEnvironment(env),
    trading212: {
      demo: { baseUrl: "https://demo.trading212.com/api/v0", apiKey: env.T212_DEMO_API_KEY ?? "", apiSecret: env.T212_DEMO_API_SECRET ?? "" },
      live: { baseUrl: "https://live.trading212.com/api/v0", apiKey: env.T212_LIVE_API_KEY ?? "", apiSecret: env.T212_LIVE_API_SECRET ?? "" },
    },
  };
}

export function credentialStatus(config: RuntimeConfig): CredentialStatus {
  return {
    demo: Boolean(config.trading212.demo.apiKey && config.trading212.demo.apiSecret),
    live: Boolean(config.trading212.live.apiKey && config.trading212.live.apiSecret),
  };
}

export function assertAuthConfigured(config: RuntimeConfig): void {
  if (!config.loginPassword || config.loginPassword === "change-this-password" || config.loginPassword.length < 16)
    throw new Error("APP_LOGIN_PASSWORD must be a non-placeholder value with at least 16 characters");
  if (config.signingSecret.length < 32 || config.signingSecret.startsWith("change-this-"))
    throw new Error("AUTH_SIGNING_SECRET must be a non-placeholder value with at least 32 characters");
  const url = new URL(config.publicBaseUrl);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS outside localhost");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("PUBLIC_BASE_URL must be an origin without credentials, query, fragment, or path");
}
