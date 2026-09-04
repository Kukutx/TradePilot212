import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const workerNameArg = process.argv.find((arg) => arg.startsWith("--name="));
const workerName = workerNameArg?.slice("--name=".length) || process.env.TRADEPILOT_WORKER_NAME || "tradepilot212";
const pnpm = "pnpm";
const shell = process.platform === "win32";

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

function run(args, options = {}) {
  const result = spawnSync(pnpm, args, {
    cwd: root,
    encoding: "utf8",
    shell,
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function requireValue(name, min = 1) {
  const value = process.env[name] ?? "";
  if (value.length < min) {
    console.error(`Missing or invalid ${name}. Run pnpm setup and edit .env.local.`);
    process.exit(1);
  }
  return value;
}

if (!fs.existsSync(path.join(root, ".env.local"))) {
  console.error("Missing .env.local. Run: pnpm setup");
  process.exit(1);
}

const loginPassword = requireValue("APP_LOGIN_PASSWORD", 16);
const signingSecret = requireValue("AUTH_SIGNING_SECRET", 32);
if (loginPassword === "change-this-password") {
  console.error("APP_LOGIN_PASSWORD is still the example placeholder. Run: pnpm setup");
  process.exit(1);
}
if (signingSecret.startsWith("change-this-")) {
  console.error("AUTH_SIGNING_SECRET is still the example placeholder. Run: pnpm setup");
  process.exit(1);
}

const pairs = [
  ["DEMO", "T212_DEMO_API_KEY", "T212_DEMO_API_SECRET"],
  ["LIVE", "T212_LIVE_API_KEY", "T212_LIVE_API_SECRET"],
];
let configured = 0;
for (const [label, keyName, secretName] of pairs) {
  const key = process.env[keyName] ?? "";
  const secret = process.env[secretName] ?? "";
  if (Boolean(key) !== Boolean(secret)) {
    console.error(`${label} credentials are incomplete. Set both ${keyName} and ${secretName}.`);
    process.exit(1);
  }
  if (key && secret) configured += 1;
}
if (!configured) {
  console.error("Configure at least one Trading 212 environment (Demo or Live) in .env.local.");
  process.exit(1);
}

console.log(`TradePilot 212 self-host deployment${dryRun ? " (dry run)" : ""}`);
console.log(`Worker name: ${workerName}`);
console.log("");

console.log("1/3 Validating project…");
run(["check"]);

if (dryRun) {
  console.log("2/3 Skipping Cloudflare login/secrets in dry-run mode.");
  console.log("3/3 Running Wrangler deploy dry-run…");
  run(["exec", "wrangler", "deploy", "--dry-run", "--name", workerName]);
  console.log("\nDry run passed. Run `pnpm deploy` for the real deployment.");
  process.exit(0);
}

console.log("2/3 Checking Cloudflare login and syncing secrets…");
const whoami = spawnSync(pnpm, ["exec", "wrangler", "whoami"], {
  cwd: root,
  encoding: "utf8",
  shell,
});
const authenticated = whoami.status === 0 && !`${whoami.stdout ?? ""}${whoami.stderr ?? ""}`.includes("not authenticated");
if (!authenticated) {
  console.log("Cloudflare login required. Your browser will open once.");
  run(["exec", "wrangler", "login"]);
}

const secrets = {
  APP_LOGIN_PASSWORD: process.env.APP_LOGIN_PASSWORD,
  AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET,
};
for (const [, keyName, secretName] of pairs) {
  if (process.env[keyName] && process.env[secretName]) {
    secrets[keyName] = process.env[keyName];
    secrets[secretName] = process.env[secretName];
  } else {
    // Explicitly remove previously configured credentials when this environment is disabled locally.
    secrets[keyName] = null;
    secrets[secretName] = null;
  }
}
const secretResult = spawnSync(pnpm, ["exec", "wrangler", "secret", "bulk", "--name", workerName], {
  cwd: root,
  input: JSON.stringify(secrets),
  encoding: "utf8",
  shell,
  stdio: ["pipe", "inherit", "inherit"],
});
if (secretResult.error || secretResult.status !== 0) {
  console.error(secretResult.error?.message ?? "Failed to sync Cloudflare secrets.");
  process.exit(secretResult.status ?? 1);
}

console.log("3/3 Deploying Worker…");
const deployment = run(["exec", "wrangler", "deploy", "--name", workerName], { capture: true });
process.stdout.write(deployment.stdout ?? "");
process.stderr.write(deployment.stderr ?? "");
const combined = `${deployment.stdout ?? ""}\n${deployment.stderr ?? ""}`;
const url = combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

console.log("\nDeployment complete.");
if (url) {
  console.log(`App: ${url}`);
  console.log(`MCP: ${url}/mcp`);
  console.log("");
  console.log("Next: add the MCP URL to ChatGPT Apps / Developer mode and connect.");
} else {
  console.log("Copy the workers.dev URL printed above and append /mcp for ChatGPT.");
}
