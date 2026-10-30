// Opens every view of the preview (sample account) at each host width, theme and language in a headless browser and
// checks what tests on the markup cannot see: the widget scrolling sideways, a box sticking out of the frame, text
// under 12px, a form control left with the browser's own look, a broken image or a script error. Each view is
// checked as it opens and again with everything folded opened: charts shown as tables, "show all" lists, collapsed
// sections and the date-range panel. With --shots it also saves a picture of each, to look over by eye.
//
//   pnpm audit:ui                          every view, 375/720/1040 px, light and dark, English and Chinese
//   pnpm audit:ui -- --views=income,pies --widths=375 --themes=dark --langs=zh-CN --shots=ui-audit
//
// It needs Playwright with Chromium (`pnpm add -D playwright && pnpm exec playwright install chromium`, or one
// already on the machine) and never reads Trading 212: the preview serves the sample account.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const list = (name, fallback) => option(name, fallback).split(",").map((item) => item.trim()).filter(Boolean);
const widths = list("widths", "375,720,1040");
const themes = list("themes", "light,dark");
const langs = list("langs", "en,zh-CN");
const shots = option("shots", "");
const parallel = Math.max(1, Number(option("parallel", "4")) || 4);

let playwright;
try {
  playwright = createRequire(path.join(root, "package.json"))("playwright");
} catch {
  try {
    playwright = await import("playwright");
  } catch {
    console.error("The UI audit needs Playwright: pnpm add -D playwright && pnpm exec playwright install chromium");
    process.exit(2);
  }
}

const port = String(4600 + Math.floor(Math.random() * 300));
const base = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/adapters/preview/index.ts", `--port=${port}`], {
  cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PREVIEW_PORT: port },
});
let previewLog = "";
preview.stdout.on("data", (chunk) => { previewLog += chunk; });
preview.stderr.on("data", (chunk) => { previewLog += chunk; });
const stop = () => { if (!preview.killed) preview.kill(); };
process.on("exit", stop);

async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (preview.exitCode !== null) throw new Error(`The preview stopped:\n${previewLog}`);
    try { if ((await fetch(base)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The preview did not start:\n${previewLog}`);
}

/** Run in the widget's frame: what is wrong with the page as drawn. */
function inspect() {
  const problems = [];
  const describe = (element) => {
    const name = element.tagName.toLowerCase();
    const classes = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${name}${classes}${text ? ` "${text}"` : ""}`;
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width + 1) problems.push(`scrolls sideways: ${document.documentElement.scrollWidth}px in ${width}px`);
  // A box past the frame's edge, unless an ancestor scrolls or clips it on purpose.
  const clipped = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow !== "visible") return true;
    }
    return false;
  };
  const sticking = [];
  for (const element of document.body.querySelectorAll("*")) {
    if (!visible(element)) continue;
    const box = element.getBoundingClientRect();
    if ((box.right > width + 1 || box.left < -1) && !clipped(element) && getComputedStyle(element).position !== "fixed") sticking.push(element);
  }
  // Only the outermost of a run of boxes that stick out.
  for (const element of sticking.filter((item) => !sticking.includes(item.parentElement))) problems.push(`past the edge: ${describe(element)} (${Math.round(element.getBoundingClientRect().right)}px of ${width}px)`);
  const small = new Set();
  for (const element of document.body.querySelectorAll("*")) {
    const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (!own || !visible(element) || element.closest(".visuallyHidden, svg")) continue;
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (size < 12) small.add(`${describe(element)} ${size}px`);
  }
  for (const item of [...small].slice(0, 5)) problems.push(`text under 12px: ${item}`);
  // The browser's own controls: each is drawn by the project (appearance: none) or hidden behind one that is.
  for (const control of document.querySelectorAll("select, input[type=checkbox], input[type=radio], input[type=range], input[type=date], input[type=search], progress, meter")) {
    if (!visible(control)) continue;
    const style = getComputedStyle(control);
    if (style.appearance !== "none" && style.opacity !== "0") problems.push(`browser-styled control: ${describe(control)} (${control.getAttribute("type") ?? control.tagName.toLowerCase()})`);
  }
  for (const image of document.querySelectorAll("img")) if (image.complete && image.naturalWidth === 0) problems.push(`broken image: ${image.getAttribute("src")}`);
  return problems;
}

async function audit(context, run) {
  const page = await context.newPage();
  page.setViewportSize({ width: Number(run.width) + 140, height: 1400 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`script error: ${error.message}`));
  // A failed request is named by its address (the console only says that something failed).
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`request failed: ${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console error: ${message.text().slice(0, 160)}`);
  });
  await page.goto(`${base}/#view=${run.view}&lang=${run.lang}&width=${run.width}&theme=${run.theme}`);
  let frame;
  let quiet = 0;
  // Ready once the widget shows something and has stopped loading for a moment; an empty or still loading widget
  // has nothing wrong to find, so it is a problem of its own.
  for (let attempt = 0; attempt < 80 && quiet < 3; attempt++) {
    await page.waitForTimeout(250);
    frame = page.frames().find((item) => item !== page.mainFrame());
    const busy = frame ? await frame.evaluate(() => document.body?.innerText.trim().length > 0 && !document.querySelector(".skeleton, [aria-busy=true]") ? 0 : 1).catch(() => 1) : 1;
    quiet = busy ? 0 : quiet + 1;
  }
  const loaded = Boolean(frame) && quiet >= 3;
  const problems = loaded ? await frame.evaluate(inspect) : [frame ? "the widget did not finish loading (empty, or still loading after 20s)" : "the widget did not load"];
  if (loaded) {
    // Everything folded, opened: the date-range panel last, as a click elsewhere closes it.
    await frame.evaluate(() => {
      for (const element of document.querySelectorAll("figcaption button.linkButton, details:not([open]) > summary, button[aria-expanded=false]:not(.rangeButton)")) element.click();
    });
    await page.waitForTimeout(400);
    await frame.evaluate(() => document.querySelector("button.rangeButton[aria-expanded=false]")?.click());
    await page.waitForTimeout(400);
    for (const problem of await frame.evaluate(inspect)) if (!problems.includes(problem)) problems.push(`opened: ${problem}`);
  }
  if (shots && loaded) {
    const file = path.join(shots, `${run.view}-${run.lang}-${run.theme}-${run.width}-opened.png`);
    await (await frame.frameElement()).screenshot({ path: file }).catch(() => page.screenshot({ path: file, fullPage: true }));
  }
  await page.close();
  return [...problems, ...errors];
}

await ready();
const browser = await playwright.chromium.launch();
const context = await browser.newContext();
const views = option("views", "") ? list("views", "") : await (async () => {
  const page = await context.newPage();
  await page.goto(base);
  const ids = await page.$$eval("select option", (options) => options.map((item) => item.value).filter(Boolean));
  await page.close();
  return [...new Set(ids)].filter((id) => /^[a-z]+$/.test(id));
})();
if (shots) await fs.mkdir(shots, { recursive: true });

const runs = views.flatMap((view) => widths.flatMap((width) => themes.flatMap((theme) => langs.map((lang) => ({ view, width, theme, lang })))));
const found = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, async () => {
  while (next < runs.length) {
    const run = runs[next++];
    for (const problem of await audit(context, run)) found.push({ ...run, problem });
  }
}));
await browser.close();
stop();

// The same problem in several themes or languages is one problem.
const grouped = new Map();
for (const item of found) {
  const key = `${item.view} ${item.width}px: ${item.problem}`;
  grouped.set(key, [...(grouped.get(key) ?? []), `${item.lang}/${item.theme}`]);
}
for (const [key, where] of grouped) console.log(`✗ ${key}  [${where.join(", ")}]`);
// Why the preview turned a request down, from its own terminal.
const failures = previewLog.split("\n").filter((line, index, lines) => line.startsWith("Preview request failed") || lines[index - 1]?.startsWith("Preview request failed"));
if (failures.length) console.log(`The preview said:\n${failures.slice(0, 10).join("\n")}`);
console.log(`${grouped.size === 0 ? "✓" : "✗"} UI audit: ${views.length} views × ${widths.length} widths × ${themes.length} themes × ${langs.length} languages, ${grouped.size} problem${grouped.size === 1 ? "" : "s"}${shots ? `; pictures in ${shots}` : ""}`);
process.exit(grouped.size === 0 ? 0 : 1);
