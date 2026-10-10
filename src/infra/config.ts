import type { Environment, Source } from "../domain/types.js";

export type RuntimeEnv = Partial<Record<
  | "PUBLIC_ORIGIN" | "PORT" | "OWNER_PASSWORD" | "JWT_SIGNING_SECRET"
  | "OAUTH_CLIENT_ORIGINS" | "DATA_SOURCE" | "DEFAULT_ENVIRONMENT"
  | "T212_DEMO_KEY" | "T212_DEMO_SECRET" | "T212_LIVE_KEY" | "T212_LIVE_SECRET",
  string
>>;
export interface Configuration {
  publicOrigin: string;
  ownerPassword: string;
  jwtSecret: string;
  trustedClientOrigins: string[];
  source: Source;
  defaultEnvironment: Environment;
  broker: Record<Environment, { origin: string; key: string; secret: string }>;
}
export function readConfiguration(env: RuntimeEnv, requestOrigin?: string): Configuration {
  const origin = (env.PUBLIC_ORIGIN || requestOrigin || "http://localhost:8080").replace(/\/+$/, "");
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !["localhost","127.0.0.1","::1"].includes(url.hostname)))
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin (or localhost for testing)");
  const source = env.DATA_SOURCE || "sample";
  if (source !== "sample" && source !== "trading212") throw new Error("DATA_SOURCE must be sample or trading212");
  const defaultEnvironment = env.DEFAULT_ENVIRONMENT || "demo";
  if (defaultEnvironment !== "demo" && defaultEnvironment !== "live")
    throw new Error("DEFAULT_ENVIRONMENT must be demo or live");
  const trustedClientOrigins = (env.OAUTH_CLIENT_ORIGINS || "https://chatgpt.com")
    .split(",").map(s=>s.trim()).filter(Boolean).map(value=>{
      const candidate = new URL(value);
      if (candidate.protocol !== "https:" || candidate.origin !== value) throw new Error("Only exact HTTPS OAuth client origins are allowed");
      return value;
    });
  if (!trustedClientOrigins.length) throw new Error("OAUTH_CLIENT_ORIGINS must not be empty");
  const ownerPassword = env.OWNER_PASSWORD || "";
  const jwtSecret = env.JWT_SIGNING_SECRET || "";
  if (ownerPassword.length < 24 || ownerPassword.startsWith("replace-with") ||
      jwtSecret.length < 48 || jwtSecret.startsWith("replace-with") || ownerPassword === jwtSecret)
    throw new Error("Owner credentials not configured: use independent OWNER_PASSWORD (24+) and JWT_SIGNING_SECRET (48+)");
  const broker = {
    demo: { origin: "https://demo.trading212.com", key: env.T212_DEMO_KEY || "", secret: env.T212_DEMO_SECRET || "" },
    live: { origin: "https://live.trading212.com", key: env.T212_LIVE_KEY || "", secret: env.T212_LIVE_SECRET || "" },
  };
  if (source === "trading212" && Object.values(broker).every(v => !v.key || !v.secret))
    throw new Error("Trading 212 mode requires complete Demo or Live credentials");
  for (const entry of Object.values(broker))
    if (Boolean(entry.key) !== Boolean(entry.secret))
      throw new Error("Trading 212 key and secret must be configured as a pair");
  return {
    publicOrigin: origin, ownerPassword, jwtSecret, trustedClientOrigins, source,
    defaultEnvironment, broker,
  };
}
