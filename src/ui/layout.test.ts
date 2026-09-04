import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("transaction layout", () => {
  it("keeps order review in normal document flow", () => {
    expect(app).toContain("transactionStage");
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
});
