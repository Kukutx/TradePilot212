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
