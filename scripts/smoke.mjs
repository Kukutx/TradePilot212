import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const root = process.cwd();
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const port = String(8200 + Math.floor(Math.random() * 500));
const base = `http://127.0.0.1:${port}`;
const password = process.env.APP_LOGIN_PASSWORD;
const signingSecret = process.env.AUTH_SIGNING_SECRET;
if (!password || !signingSecret) throw new Error(".env.local must contain APP_LOGIN_PASSWORD and AUTH_SIGNING_SECRET");

const child = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/adapters/node/index.ts"], {
  cwd: root,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: port, PUBLIC_BASE_URL: base },
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Server did not become healthy");
}

try {
  await waitForHealth();

  const protectedMetadata = await fetch(`${base}/.well-known/oauth-protected-resource`).then((response) => response.json());
  assert(protectedMetadata.resource === `${base}/mcp`, "Protected-resource metadata has the wrong resource URL");

  const unauthorized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert(unauthorized.status === 401, "Unauthenticated MCP request should return 401");
  assert(unauthorized.headers.get("www-authenticate")?.includes("resource_metadata"), "401 must advertise resource metadata");

  const redirectUri = "http://127.0.0.1:9999/oauth/callback";
  const registrationResponse = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "TradePilot smoke test",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  assert(registrationResponse.status === 201, `DCR failed: ${registrationResponse.status}`);
  const registration = await registrationResponse.json();

  const verifier = crypto.randomBytes(40).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "smoke-state",
    resource: `${base}/mcp`,
    scope: "trade:read trade:write",
  });

  const authorizePage = await fetch(`${base}/oauth/authorize?${authorizeParams}`);
  assert(authorizePage.ok && (await authorizePage.text()).includes("TradePilot 212"), "Authorization page did not render");

  const authorization = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), password }),
  });
  assert(authorization.status === 302, `Authorization failed: ${authorization.status}`);
  const location = authorization.headers.get("location");
  assert(location, "Authorization did not return a redirect");
  const oauthCallback = new URL(location);
  const code = oauthCallback.searchParams.get("code");
  assert(code, "Authorization redirect did not contain a code");
  assert(oauthCallback.searchParams.get("iss") === base, "OAuth response must identify its issuer");

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(tokenResponse.ok, `Token exchange failed: ${tokenResponse.status}`);
  const token = await tokenResponse.json();
  assert(token.access_token, "Token exchange returned no access token");

  const initialize = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "tradepilot-smoke", version: "1.0.0" },
      },
    }),
  });
  const initializeText = await initialize.text();
  assert(initialize.ok, `Authenticated MCP initialize failed: ${initialize.status} ${initializeText}`);
  assert(initializeText.includes("tradepilot212"), "MCP initialize response did not identify TradePilot 212");

  const tools = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
  });
  const toolsText = await tools.text();
  assert(tools.ok, `Authenticated MCP tools/list failed: ${tools.status} ${toolsText}`);
  assert(toolsText.includes("review_trading212_order_intent"), "Flexible natural-language order tool is missing");
  assert(toolsText.includes("get_recent_trading_activity"), "Recent activity tool is missing");
  assert(toolsText.includes("app_verify_unknown_execution"), "Unknown-execution verification tool is missing");

  // A read-only host connection must never even advertise write-path tools.
  const readOnlyAuthorization = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...Object.fromEntries(authorizeParams),
      scope: "trade:read",
      password,
    }),
  });
  assert(readOnlyAuthorization.status === 302, "Read-only authorization failed");
  const readOnlyCode = new URL(readOnlyAuthorization.headers.get("location")).searchParams.get("code");
  const readOnlyTokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: readOnlyCode,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(readOnlyTokenResponse.ok, "Read-only token exchange failed");
  const readOnlyToken = await readOnlyTokenResponse.json();
  const readOnlyTools = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readOnlyToken.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
  });
  const readOnlyText = await readOnlyTools.text();
  assert(readOnlyTools.ok, "Read-only MCP tools/list failed");
  assert(readOnlyText.includes("get_portfolio_dashboard"), "Read-only portfolio tool is missing");
  assert(!readOnlyText.includes("review_trading212_order_intent"), "Read-only token exposes order preview tool");
  assert(!readOnlyText.includes("app_execute_order"), "Read-only token exposes broker execution tool");
  assert(!readOnlyText.includes("app_execute_cancel"), "Read-only token exposes broker cancellation tool");

  console.log("SMOKE_OK OAuth PKCE + issuer + MCP tools + read-only scope enforcement");
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
