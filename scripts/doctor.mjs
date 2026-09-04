import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const root = process.cwd();
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const checks = [];
function result(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

result("Node.js", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node);
result(".env.local", fs.existsSync(path.join(root, ".env.local")), fs.existsSync(path.join(root, ".env.local")) ? "found" : "run pnpm setup");

const password = process.env.APP_LOGIN_PASSWORD ?? "";
const signing = process.env.AUTH_SIGNING_SECRET ?? "";
result("OAuth login password", password.length >= 16 && password !== "change-this-password", password ? "configured" : "missing");
result("OAuth signing secret", signing.length >= 32 && !signing.startsWith("change-this-"), signing ? "configured" : "missing");

const defaultEnvironment = (process.env.DEFAULT_TRADING_ENV ?? "demo").trim().toLowerCase();
result("Default trading environment", ["demo", "live"].includes(defaultEnvironment), defaultEnvironment);

function nonNegativeSetting(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  result(name, Number.isFinite(value) && value >= 0, value === 0 ? "app-level cap disabled" : raw);
}
nonNegativeSetting("MAX_ORDER_NOTIONAL", 5000);
nonNegativeSetting("MAX_ORDER_QUANTITY", 100000);
const confirmationTtl = Number(process.env.CONFIRMATION_TTL_SECONDS ?? "90");
result("CONFIRMATION_TTL_SECONDS", Number.isFinite(confirmationTtl) && confirmationTtl > 0, String(confirmationTtl));

function pair(prefix) {
  const key = process.env[`T212_${prefix}_API_KEY`] ?? "";
  const secret = process.env[`T212_${prefix}_API_SECRET`] ?? "";
  return { key, secret, complete: Boolean(key && secret), partial: Boolean(key || secret) && !(key && secret) };
}

const environments = [
  ["DEMO", pair("DEMO"), "https://demo.trading212.com/api/v0/equity/account/summary"],
  ["LIVE", pair("LIVE"), "https://live.trading212.com/api/v0/equity/account/summary"],
];

for (const [name, credentials, url] of environments) {
  if (credentials.partial) {
    result(`Trading 212 ${name}`, false, "API key/secret pair is incomplete");
    continue;
  }
  if (!credentials.complete) {
    result(`Trading 212 ${name}`, true, "not configured (optional)");
    continue;
  }
  try {
    const auth = Buffer.from(`${credentials.key}:${credentials.secret}`, "utf8").toString("base64");
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    result(`Trading 212 ${name}`, response.ok, response.ok ? "connected" : `HTTP ${response.status}`);
  } catch (error) {
    result(`Trading 212 ${name}`, false, error instanceof Error ? error.message : String(error));
  }
}

const atLeastOne = pair("DEMO").complete || pair("LIVE").complete;
result("Trading environment", atLeastOne, atLeastOne ? "ready" : "configure Demo and/or Live credentials");

if (checks.some((check) => !check.ok)) process.exitCode = 1;
