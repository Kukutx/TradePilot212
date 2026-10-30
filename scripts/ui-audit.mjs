// Opens every view of the preview (sample account) at each host width, theme and language in a headless browser and
// checks what tests on the markup cannot see: the widget scrolling sideways, a box sticking out of the frame, text cut
// off with nothing showing the rest, text under 12px, low contrast, a control too small to tap, a control with no
// focus ring or focused out of view, a form control left with the browser's own look, a broken image, a failed
// request or a script error. Each view is checked as it opens, again with
// everything folded opened (charts shown as tables, "show all" lists, collapsed sections, the date-range panel), and
// after each choice of every switch and tab list in it. With --shots it also saves pictures, to look over by eye.
//
//   pnpm audit:ui                          every view, 375/720/1040 px, light and dark, English and Chinese
//   pnpm audit:ui -- --views=income,pies --widths=375 --themes=dark --langs=zh-CN --shots=ui-audit
//
// It exits 0 when nothing is wrong, 1 when it found problems and 2 when it could not check (a wrong option, no
// Playwright, the preview not starting). It needs Playwright with Chromium (`pnpm add -D playwright && pnpm exec
// playwright install chromium`, or one already on the machine) and never reads Trading 212: the preview it starts
// serves the sample account.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const fail = (message) => { console.error(message); process.exit(2); };
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
// A misspelt choice would quietly fall back to the preview's default and check something else, so it stops the run.
const list = (name, fallback, allowed) => {
  const items = option(name, fallback).split(",").map((item) => item.trim()).filter(Boolean);
  const wrong = allowed ? items.filter((item) => !allowed.includes(item)) : [];
  if (wrong.length) fail(`Unknown --${name}: ${wrong.join(", ")} (choose from ${allowed.join(", ")})`);
  if (!items.length) fail(`--${name} names nothing`);
  return items;
};
const widths = list("widths", "375,720,1040", ["375", "720", "1040"]);
const themes = list("themes", "light,dark", ["light", "dark"]);
const langs = list("langs", "en,zh-CN", ["en", "zh-CN"]);
const shots = option("shots", "");
const parallel = Math.max(1, Number(option("parallel", "4")) || 4);

let playwright;
try {
  playwright = createRequire(path.join(root, "package.json"))("playwright");
} catch {
  try {
    playwright = await import("playwright");
  } catch {
    fail("The UI audit needs Playwright: pnpm add -D playwright && pnpm exec playwright install chromium");
  }
}

// The preview this run starts, and no other server that happens to answer on the port: it is ready when it says it
// is listening, and a port already taken makes it stop, so another one is tried.
let preview;
let previewLog = "";
const stop = () => { if (preview && preview.exitCode === null && !preview.killed) preview.kill(); };
process.on("exit", stop);

async function startPreview() {
  for (let tries = 0; tries < 5; tries++) {
    const port = String(4600 + Math.floor(Math.random() * 300));
    previewLog = "";
    preview = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/adapters/preview/index.ts", `--port=${port}`], {
      cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PREVIEW_PORT: port },
    });
    preview.stdout.on("data", (chunk) => { previewLog += chunk; });
    preview.stderr.on("data", (chunk) => { previewLog += chunk; });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (previewLog.includes(`(sample account): http://127.0.0.1:${port}`)) return `http://127.0.0.1:${port}`;
      if (previewLog.includes("your Demo account")) { stop(); fail("The preview started on a Trading 212 account; the audit only runs on the sample account."); }
      if (preview.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!previewLog.includes("EADDRINUSE")) break;
  }
  stop();
  fail(`The preview did not start:\n${previewLog}`);
}

/** Run in the widget's frame: what is wrong with the page as drawn. `host` is what the host page paints behind the
 * frame, from the frame up, as the frame itself may be transparent. */
function inspect(host = []) {
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
  const ownText = (element) => [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
  const hidden = (element) => element.closest(".visuallyHidden");
  const all = [...document.body.querySelectorAll("*")].filter((element) => visible(element) && !hidden(element));
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width + 1) problems.push(`scrolls sideways: ${document.documentElement.scrollWidth}px in ${width}px`);

  // A box past the frame's edge, unless an ancestor scrolls or clips it on purpose (what a clip hides is checked
  // below). A fixed box cannot be scrolled to, so it is held to the frame alone.
  const clipped = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== "visible") return true;
    }
    return false;
  };
  const sticking = [];
  for (const element of all) {
    if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") continue;
    const box = element.getBoundingClientRect();
    if ((box.right > width + 1 || box.left < -1) && (getComputedStyle(element).position === "fixed" || !clipped(element))) sticking.push(element);
  }
  // Only the outermost of a run of boxes that stick out.
  for (const element of sticking.filter((item) => !sticking.includes(item.parentElement))) problems.push(`past the edge: ${describe(element)} (${Math.round(element.getBoundingClientRect().right)}px of ${width}px)`);

  // Text cut off: by its own box with no ellipsis, by a box around it that clips, or cut short (an ellipsis or a line
  // clamp) with no title to read the rest in.
  const cut = new Set();
  for (const element of all) {
    if (!ownText(element) || element.closest("svg")) continue;
    const style = getComputedStyle(element);
    const titled = Boolean(element.closest("[title]"));
    const clamp = style.webkitLineClamp && style.webkitLineClamp !== "none";
    if (["hidden", "clip"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1) {
      if (style.textOverflow !== "ellipsis") cut.add(`text cut off: ${describe(element)}`);
      else if (!titled) cut.add(`text cut short with no title: ${describe(element)}`);
    } else if (clamp && element.scrollHeight > element.clientHeight + 1 && !titled) cut.add(`text cut short with no title: ${describe(element)}`);
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow === "visible") continue;
      const edge = parent.getBoundingClientRect();
      if (["hidden", "clip"].includes(overflow) && (box.right > edge.right + 1 || box.left < edge.left - 1) && !titled) cut.add(`text cut off by its box: ${describe(element)}`);
      break;
    }
  }
  for (const item of [...cut].slice(0, 6)) problems.push(item);

  // Text under 12px: in elements, in what CSS adds before and after them, in form fields, and in charts as drawn
  // (an SVG scaled to fit draws its text smaller or larger than its font size).
  const small = new Set();
  for (const element of all) {
    const tag = element.tagName.toLowerCase();
    if (element.closest("svg")) {
      if ((tag === "text" || tag === "tspan") && ownText(element)) {
        const matrix = element.getScreenCTM();
        const drawn = parseFloat(getComputedStyle(element).fontSize) * (matrix ? Math.hypot(matrix.a, matrix.b) : 1);
        if (drawn < 11.5) small.add(`${describe(element)} ${drawn.toFixed(1)}px as drawn`);
      }
      continue;
    }
    const field = ["input", "select", "textarea"].includes(tag) && !["checkbox", "radio", "range", "hidden"].includes(element.getAttribute("type") ?? "");
    const size = parseFloat(getComputedStyle(element).fontSize);
    if ((ownText(element) || field) && size < 12) small.add(`${describe(element)} ${size}px`);
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (/^["'].*\S.*["']$/.test(style.content) && style.display !== "none" && parseFloat(style.fontSize) < 12) small.add(`${describe(element)}${pseudo} ${style.fontSize}`);
    }
  }
  for (const item of [...small].slice(0, 5)) problems.push(`text under 12px: ${item}`);

  // Controls under 24px either way (WCAG 2.5.8), counting the label a checkbox or radio sits in.
  const tiny = new Set();
  for (const control of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, [role=radio], [role=tab], [role=button], summary")) {
    if (!visible(control) || hidden(control) || control.disabled) continue;
    const target = control.closest("label") ?? control;
    const box = target.getBoundingClientRect();
    if (box.width < 23.5 || box.height < 23.5) tiny.add(`${describe(control)} ${Math.round(box.width)}×${Math.round(box.height)}px`);
  }
  for (const item of [...tiny].slice(0, 5)) problems.push(`too small to tap: ${item}`);

  // Text against what is behind it: 4.5:1, or 3:1 for large text (WCAG 1.4.3). Disabled controls are exempt, and
  // text over a picture or gradient is left alone, as what is behind it cannot be read off the styles.
  const parse = (value) => {
    const rgb = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/.exec(value);
    if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value);
    return srgb ? [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), srgb[4] === undefined ? 1 : Number(srgb[4])] : null;
  };
  const over = (top, bottom) => [0, 1, 2].map((index) => top[index] * top[3] + bottom[index] * (1 - top[3])).concat(1);
  const luminance = (color) => {
    const [r, g, b] = color.slice(0, 3).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const faint = new Set();
  for (const element of all) {
    if (!ownText(element) || element.closest("svg, :disabled, [aria-disabled=true]")) continue;
    const style = getComputedStyle(element);
    let text = parse(style.color);
    if (!text) continue;
    let fade = 1;
    const layers = [];
    let unknown = false;
    for (let node = element; node; node = node.parentElement) {
      const own = getComputedStyle(node);
      if (own.backgroundImage !== "none") { unknown = true; break; }
      const background = parse(own.backgroundColor);
      if (background && background[3] > 0) layers.push(background);
      if (background?.[3] === 1) break;
      if (layers.length === 0) fade *= Number(own.opacity);
    }
    if (unknown) continue;
    if (layers.at(-1)?.[3] !== 1) layers.push(...host.map(parse).filter((layer) => layer && layer[3] > 0));
    const behind = layers.reverse().reduce((under, layer) => over(layer, under), [1, 1, 1, 1]);
    text = over([text[0], text[1], text[2], text[3] * fade], behind);
    const [light, dark] = [luminance(text), luminance(behind)].sort((a, b) => b - a);
    const ratio = (light + 0.05) / (dark + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5) - 0.05) faint.add(`${describe(element)} ${ratio.toFixed(2)}:1`);
  }
  for (const item of [...faint].slice(0, 5)) problems.push(`low contrast: ${item}`);

  // The browser's own controls: each is drawn by the project (appearance: none, or textfield for a number box without
  // its spinner) or hidden behind one that is.
  for (const control of document.querySelectorAll("select, input[type=checkbox], input[type=radio], input[type=range], input[type=date], input[type=search], input[type=number], input[type=file], input[type=color], progress, meter")) {
    if (!visible(control)) continue;
    const style = getComputedStyle(control);
    if (!["none", "textfield"].includes(style.appearance) && style.opacity !== "0") problems.push(`browser-styled control: ${describe(control)} (${control.getAttribute("type") ?? control.tagName.toLowerCase()})`);
  }
  for (const image of document.querySelectorAll("img")) if (image.complete && image.naturalWidth === 0) problems.push(`broken image: ${image.getAttribute("src")}`);
  return problems;
}

/** Waits until the widget shows something and has stopped loading for a moment; false when it never does. */
async function settle(page, limit = 80) {
  let quiet = 0;
  for (let attempt = 0; attempt < limit && quiet < 3; attempt++) {
    await page.waitForTimeout(250);
    const frame = page.frames().find((item) => item !== page.mainFrame());
    const busy = frame ? await frame.evaluate(() => document.body?.innerText.trim().length > 0 && !document.querySelector(".skeleton, [aria-busy=true]") ? 0 : 1).catch(() => 1) : 1;
    quiet = busy ? 0 : quiet + 1;
  }
  return quiet >= 3;
}

async function audit(context, base, run) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`script error: ${error.message}`));
  // A failed request is named by its address (the console only says that something failed).
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`request failed: ${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console error: ${message.text().slice(0, 160)}`);
  });
  try {
    await page.setViewportSize({ width: Number(run.width) + 140, height: 1400 });
    await page.goto(`${base}/#view=${run.view}&lang=${run.lang}&width=${run.width}&theme=${run.theme}`);
    // The preview's own bar stays at the top of a tall picture and would cover the widget's.
    if (shots) await page.addStyleTag({ content: "header { position: static !important; }" });
    // An empty or still loading widget has nothing wrong to find, so it is a problem of its own.
    if (!await settle(page)) return [page.frames().length > 1 ? "the widget did not finish loading (empty, or still loading after 20s)" : "the widget did not load", ...errors];
    const frame = page.frames().find((item) => item !== page.mainFrame());
    const picture = async (state) => {
      if (!shots) return;
      const file = path.join(shots, `${run.view}-${run.lang}-${run.theme}-${run.width}${state}.png`);
      await (await frame.frameElement()).screenshot({ path: file }).catch(() => page.screenshot({ path: file, fullPage: true }));
    };
    const seen = new Set();
    const problems = [];
    const host = await (await frame.frameElement()).evaluate((element) => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        layers.push(getComputedStyle(node).backgroundColor);
        if (/^rgb\(/.test(layers.at(-1))) break;
      }
      return layers;
    });
    const note = async (prefix) => {
      // A view fading in is measured once it has: half-way, its text is fainter than it will be.
      await frame.evaluate(() => Promise.race([
        Promise.all(document.getAnimations().filter((item) => item.effect?.getComputedTiming().iterations !== Infinity).map((item) => item.finished.catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]));
      for (const problem of await frame.evaluate(inspect, host)) if (!seen.has(problem)) { seen.add(problem); problems.push(`${prefix}${problem}`); }
    };
    await note("");
    await picture("");
    // With the keyboard, from the first control to the last: each shows a focus ring and is scrolled into view.
    await frame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
    const visited = new Set();
    for (let step = 0; step < 120; step++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      const stop = await frame.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return { done: true };
        const key = [...document.querySelectorAll("*")].indexOf(element);
        const name = `${element.tagName.toLowerCase()}${typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/)[0]}` : ""} "${(element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
        // The ring is on the control, or, for a control drawn by what follows it (a switch), on that: an outline, or
        // a shadow or border it does not have unfocused.
        const parts = [element, element.nextElementSibling, element.closest("label")].filter(Boolean);
        const look = () => parts.map((item) => {
          const style = getComputedStyle(item);
          return { outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0, rest: `${style.boxShadow}|${style.borderColor}` };
        });
        const focused = look();
        element.blur();
        const resting = look();
        element.focus({ focusVisible: true });
        const ringed = focused.some((item, index) => item.outline || item.rest !== resting[index].rest);
        const box = element.getBoundingClientRect();
        let hidden = false;
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX === "visible") continue;
          const edge = parent.getBoundingClientRect();
          hidden ||= box.left < edge.left - 1 || box.right > edge.right + 1;
        }
        return { key, name, problems: [ringed ? "" : `no focus ring: ${name}`, hidden ? `focused out of view: ${name}` : ""].filter(Boolean) };
      });
      if (stop.done || visited.has(stop.key)) break;
      visited.add(stop.key);
      for (const problem of stop.problems) if (!seen.has(problem)) { seen.add(problem); problems.push(problem); }
    }
    // Everything folded, opened, twice for what the first round shows; the date-range panel last, as a click
    // elsewhere closes it.
    for (let round = 0; round < 2; round++) {
      await frame.evaluate(() => {
        for (const element of document.querySelectorAll("figcaption button.linkButton, details:not([open]) > summary, button[aria-expanded=false]:not(.rangeButton)")) element.click();
      });
      await settle(page, 20);
    }
    await frame.evaluate(() => document.querySelector("button.rangeButton[aria-expanded=false]")?.click());
    await settle(page, 20);
    await note("opened: ");
    await picture("-opened");
    // Each choice of every switch and tab list, one at a time.
    const groups = await frame.evaluate(() => document.querySelectorAll("[role=radiogroup], [role=tablist]").length);
    for (let group = 0; group < groups; group++) {
      for (let choice = 0; choice < 12; choice++) {
        const label = await frame.evaluate(([group, choice]) => {
          const option = document.querySelectorAll("[role=radiogroup], [role=tablist]")[group]?.querySelectorAll("[role=radio], [role=tab]")[choice];
          if (!option || option.disabled || option.getAttribute("aria-checked") === "true" || option.getAttribute("aria-selected") === "true") return option ? "" : null;
          option.click();
          return (option.getAttribute("aria-label") || option.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
        }, [group, choice]);
        if (label === null) break;
        if (!label) continue;
        await settle(page, 20);
        await note(`after choosing "${label}": `);
      }
    }
    return [...problems, ...errors];
  } catch (error) {
    return [`the audit could not finish this view: ${String(error?.message ?? error).split("\n")[0]}`, ...errors];
  } finally {
    await page.close().catch(() => {});
  }
}

const base = await startPreview();
const browser = await playwright.chromium.launch();
const context = await browser.newContext();
const known = await (async () => {
  const page = await context.newPage();
  await page.goto(base);
  const ids = await page.$$eval("select option", (options) => options.map((item) => item.value).filter(Boolean));
  await page.close();
  return [...new Set(ids)].filter((id) => /^[a-z]+$/.test(id));
})();
if (!known.length) { await browser.close(); stop(); fail("The preview listed no views to check"); }
const views = option("views", "") ? list("views", "", known) : known;
if (shots) await fs.mkdir(shots, { recursive: true });

const runs = views.flatMap((view) => widths.flatMap((width) => themes.flatMap((theme) => langs.map((lang) => ({ view, width, theme, lang })))));
const found = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, async () => {
  while (next < runs.length) {
    const run = runs[next++];
    for (const problem of await audit(context, base, run)) found.push({ ...run, problem });
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
const crashed = found.some((item) => item.problem.startsWith("the audit could not finish"));
process.exit(crashed ? 2 : grouped.size === 0 ? 0 : 1);
