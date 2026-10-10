// Bundle the stdio MCP server and the widget into plugin/, so the Claude plugin runs without
// `pnpm install`. Claude Code does not run build steps when installing a plugin.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const root = process.cwd();
const outDir = path.join(root, "plugin");
const widget = path.join(root, "dist", "widget", "index.html");

await fs.mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "adapters", "stdio", "index.ts")],
  outfile: path.join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
  // Some bundled CommonJS dependencies call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __tpCreateRequire } from 'node:module'; const require = __tpCreateRequire(import.meta.url);" },
});
try {
  await fs.copyFile(widget, path.join(outDir, "widget.html"));
} catch {
  throw new Error("dist/widget/index.html is missing. Run `pnpm build:widget` first.");
}
console.log("Plugin bundle written to plugin/server.mjs and plugin/widget.html");
