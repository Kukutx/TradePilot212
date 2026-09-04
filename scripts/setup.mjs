import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, ".env.local");
const example = path.join(root, ".env.example");

if (!fs.existsSync(example)) {
  console.error("Missing .env.example. Run this command from the TradePilot212 project root.");
  process.exit(1);
}

function randomSecret(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function setValue(text, key, value) {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^${key}=.*$`, "m");
  return matcher.test(text) ? text.replace(matcher, line) : `${text.trimEnd()}\n${line}\n`;
}

if (!fs.existsSync(target)) {
  let text = fs.readFileSync(example, "utf8");
  text = setValue(text, "APP_LOGIN_PASSWORD", `tp-${randomSecret(18)}`);
  text = setValue(text, "AUTH_SIGNING_SECRET", randomSecret(48));
  fs.writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
  console.log("Created .env.local with secure OAuth secrets.");
} else {
  let text = fs.readFileSync(target, "utf8");
  let changed = false;
  const password = /^APP_LOGIN_PASSWORD=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const signing = /^AUTH_SIGNING_SECRET=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  if (!password || password === "change-this-password" || password.length < 16) {
    text = setValue(text, "APP_LOGIN_PASSWORD", `tp-${randomSecret(18)}`);
    changed = true;
  }
  if (!signing || signing.startsWith("change-this-") || signing.length < 32) {
    text = setValue(text, "AUTH_SIGNING_SECRET", randomSecret(48));
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(target, text, "utf8");
    console.log("Updated weak/missing OAuth secrets in .env.local.");
  } else {
    console.log("Existing .env.local kept unchanged.");
  }
}

console.log("");
console.log("Next:");
console.log("1. Open .env.local");
console.log("2. Paste your Trading 212 Demo and/or Live API key + secret");
console.log("3. Run: pnpm doctor");
console.log("4. Cloudflare: pnpm deploy");
console.log("   Local Node: pnpm dev");
console.log("");
console.log("Never commit .env.local or share its contents.");
