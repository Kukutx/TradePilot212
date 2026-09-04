import { describe, expect, it } from "vitest";
import { safeEqual, sha256Base64Url } from "./web-utils.js";

describe("OAuth PKCE", () => {
  it("computes and compares the RFC 7636 S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await sha256Base64Url(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(await safeEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(await safeEqual(challenge, "wrong")).toBe(false);
  });
});
