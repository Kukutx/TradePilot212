import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = process.cwd();
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const port = process.env.PORT || "8000";
const build = spawnSync("pnpm", ["build:widget"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);

const generatedPassword = !process.env.APP_LOGIN_PASSWORD;
const loginPassword = process.env.APP_LOGIN_PASSWORD || `tp-${crypto.randomBytes(12).toString("base64url")}`;
const signingSecret = process.env.AUTH_SIGNING_SECRET || crypto.randomBytes(48).toString("base64url");
if (loginPassword === "change-this-password") {
  console.error("Refusing insecure APP_LOGIN_PASSWORD=change-this-password. Set a real password or remove it to generate an ephemeral one.");
  process.exit(1);
}

console.log("Starting secure Cloudflare quick tunnel…");
const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});

let server = null;
let started = false;
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function maybeStartServer(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  if (started) return;
  const match = text.match(urlPattern);
  if (!match) return;
  started = true;
  const publicBaseUrl = match[0];
  console.log("\n============================================================");
  console.log(`ChatGPT MCP URL: ${publicBaseUrl}/mcp`);
  console.log(`OAuth login password: ${loginPassword}`);
  if (generatedPassword) console.log("(ephemeral password generated for this run)");
  console.log("============================================================\n");

  server = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/adapters/node/index.ts"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      PORT: port,
      PUBLIC_BASE_URL: publicBaseUrl,
      APP_LOGIN_PASSWORD: loginPassword,
      AUTH_SIGNING_SECRET: signingSecret,
    },
  });
  server.on("exit", (code) => {
    if (tunnel.exitCode === null) tunnel.kill();
    process.exitCode = code ?? 1;
  });
}

tunnel.stdout.on("data", maybeStartServer);
tunnel.stderr.on("data", maybeStartServer);
tunnel.on("exit", (code) => {
  if (!started) console.error(`cloudflared exited before producing a public URL (code ${code ?? "unknown"})`);
  if (server?.exitCode === null) server.kill();
  process.exitCode = code ?? 1;
});

function shutdown() {
  if (server?.exitCode === null) server.kill();
  if (tunnel.exitCode === null) tunnel.kill();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
