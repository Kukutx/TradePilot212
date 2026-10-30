import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const orderViews = readFileSync(new URL("./views/OrderViews.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const common = readFileSync(new URL("./components/common.tsx", import.meta.url), "utf8");
const basketView = readFileSync(new URL("./views/BasketView.tsx", import.meta.url), "utf8");
const piesView = readFileSync(new URL("./views/PiesView.tsx", import.meta.url), "utf8");

describe("transaction layout", () => {
  it("keeps order review in normal document flow", () => {
    expect(orderViews).toContain("transactionStage");
    expect(css).toContain(".transactionStage");
    expect(css).toContain(".transactionPanel");
    expect(css).not.toContain(".modalBackdrop");
    expect(css).not.toMatch(/\.transactionPanel\s*\{[^}]*max-height/s);
    expect(css).not.toMatch(/\.transactionPanel\s*\{[^}]*overflow:\s*(auto|scroll)/s);
  });

  it("renders only the active transaction step", () => {
    expect(app).toContain("draft && !preview && !cancelPreview");
    expect(app).toContain("preview && !cancelPreview");
    expect(app).toContain("!transactionActive");
  });

  it("never asks for fullscreen without a click", () => {
    // The only requestDisplayMode call is in the Full view button's handler.
    expect(app.match(/requestDisplayMode\(/g)).toHaveLength(1);
    expect(app).toMatch(/async function toggleDisplayMode\(\)[^]*?requestDisplayMode\(/);
    expect(app).not.toMatch(/innerHeight/);
  });

  it("gives confirmation panels dialog semantics", () => {
    expect(common).toContain('role: "dialog"');
    expect(common).toContain('"aria-modal": true');
    expect(common).toContain('"aria-labelledby": headingId');
    for (const view of [orderViews, basketView, piesView]) expect(view).toContain("useDialog()");
    expect(orderViews).not.toMatch(/visuallyHidden[^>]*>\{locale\}/);
  });

  it("opens a drafted cancellation in the cancel confirmation", () => {
    expect(app).toContain('base?.kind === "cancel_draft"');
    expect(app).toContain('"app_prepare_cancel"');
    expect(app).toContain('t("cancelOrderGone")');
  });
});

describe("narrow layout", () => {
  const block = (selector: string, source = css) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...source.matchAll(new RegExp(`(?:^|[},\\s])${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]).join(";");
  };
  const narrow = css.slice(css.indexOf("@container (max-width: 640px)"));

  it("keeps text at 12px or more", () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  });

  it("gives buttons 14px labels and touch-sized targets", () => {
    expect(block(".secondaryButton, .primaryButton, .dangerButton")).toMatch(/font-size:\s*14px/);
    expect(block(".secondaryButton, .primaryButton, .dangerButton")).toMatch(/min-height:\s*4[0-9]px/);
    expect(block(".secondaryButton.danger")).toMatch(/min-height:\s*4[0-9]px/);
    expect(narrow).toMatch(/\.viewTabs button, \.segmented button, \.linkButton \{ min-height: 40px; \}/);
    expect(narrow).toMatch(/\.environmentSwitch button, \.languageSwitch button \{ min-height: 40px; \}/);
  });

  it("shows pie slices as a list on phones so no column is cut off", () => {
    expect(css).toMatch(/@container \(max-width: 420px\)[^@]*\.pieTableWrap \{ display: none; \}[^@]*\.sliceList \{ display: grid; \}/);
  });
});

describe("native controls", () => {
  it("draws scrollbars, selects, checkboxes, search, spinners and disclosures in the widget's own style", () => {
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*border-radius: 999px/);
    expect(css).toMatch(/::-webkit-scrollbar-button\s*\{[^}]*display: none/);
    expect(css).toMatch(/select:not\(\[multiple\]\)\s*\{[^}]*appearance: none/s);
    expect(css).toMatch(/input\[type="checkbox"\]\s*\{[^}]*appearance: none/s);
    expect(css).toMatch(/input\[type="number"\]\s*\{[^}]*appearance: textfield/);
    // Search and date boxes are drawn as the other text boxes (pnpm audit:ui finds any control left out).
    expect(css).toMatch(/input\[type="search"\]\s*\{[^}]*appearance: none/);
    expect(css).toMatch(/\.field input\[type="date"\]\s*\{[^}]*appearance: none/);
    // <small> is never drawn under 12px, however small its parent's text.
    expect(css).toContain("small { font-size: max(12px, .85em); }");
    expect(css).toContain("::-webkit-search-cancel-button");
    // A search box draws its own clear button (Firefox has none), so the browser's is hidden there.
    expect(css).toContain(".searchField input::-webkit-search-cancel-button { display: none; }");
    // The loading sweep and the skeletons hold still for reduced motion.
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.loadingBar::before \{[^}]*animation: none/);
    expect(css).toContain("summary::-webkit-details-marker { display: none; }");
    // Native popups (a select's list) follow the theme.
    expect(css).toContain(':root[data-theme="dark"] :is(select, input, textarea) { color-scheme: dark; }');
    // No resize grip: notes grow with what is typed.
    expect(css).not.toMatch(/resize: (vertical|both)/);
  });

  it("keeps the drawn controls readable in high contrast, and draws every disclosure's chevron and focus ring", () => {
    const forced = [...css.matchAll(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
    expect(forced).toMatch(/input\[type="checkbox"\]:checked \{[^}]*background: Highlight/);
    expect(forced).toMatch(/\.toggleField input:checked \+ \.toggleTrack \{[^}]*background: Highlight/);
    expect(forced).toMatch(/select:not\(\[multiple\]\) \{[^}]*appearance: auto/);
    expect(forced).toMatch(/\.segmented button\.active[^{]*\{[^}]*background: Highlight/);
    expect(css).toMatch(/summary:focus-visible \{ outline/);
    expect(css).toMatch(/\.activityPanel details > summary::after \{/);
    expect(css).toMatch(/::placeholder \{ color: var\(--tp-muted\)/);
    expect(css).toContain("accent-color: var(--tp-primary-bg)");
  });

  it("keeps a loading view's tabs focusable", () => {
    expect(app).toContain("aria-disabled={busy && !active ? true : undefined}");
    expect(app).not.toContain("disabled={busy && !active}");
  });
});
