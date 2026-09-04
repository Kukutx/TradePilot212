import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const root = process.cwd();
const ignoredDirs = new Set([".git", "node_modules", "dist", ".data", ".wrangler", "coverage"]);
const ignoredFiles = new Set([".env.local", ".env", ".dev.vars"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".yml", ".yaml", ".html", ".css", ".txt"]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (!ignoredFiles.has(entry.name) && textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

const envPath = path.join(root, ".env.local");
if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
const sensitiveNames = [
  "APP_LOGIN_PASSWORD",
  "AUTH_SIGNING_SECRET",
  "T212_DEMO_API_KEY",
  "T212_DEMO_API_SECRET",
  "T212_LIVE_API_KEY",
  "T212_LIVE_API_SECRET",
];
const sensitiveValues = sensitiveNames
  .map((name) => [name, process.env[name] ?? ""])
  .filter(([, value]) => value.length >= 8 && !value.startsWith("change-this") && !value.startsWith("replace-with"));

let failed = false;
for (const file of walk(root)) {
  const content = fs.readFileSync(file, "utf8");
  for (const [name, value] of sensitiveValues) {
    if (content.includes(value)) {
      console.error(`Secret leak check failed: ${name} appears in ${path.relative(root, file)}`);
      failed = true;
    }
  }
}

if (fs.existsSync(path.join(root, ".git"))) {
  for (const sensitiveFile of [".env.local", ".env", ".dev.vars", ".data/state.json"]) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", sensitiveFile], { cwd: root, stdio: "ignore" });
    if (tracked.status === 0) {
      console.error(`Release check failed: ${sensitiveFile} is tracked by Git.`);
      failed = true;
    }
  }
}

for (const required of ["LICENSE", "SECURITY.md", "CONTRIBUTING.md", "README.md", "README.zh-CN.md", ".env.example"]) {
  if (!fs.existsSync(path.join(root, required))) {
    console.error(`Release check failed: missing ${required}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("✓ Release safety check passed: no local credential values found in publishable text files.");
