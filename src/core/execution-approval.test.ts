import { describe, expect, it } from "vitest";
import { createConfig, isExecutionApprovalConfigured } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { requireExecutionApproval } from "./execution-approval.js";

function fixture(secret = "independent-human-approval-secret") {
  return createConfig({
    APP_LOGIN_PASSWORD: "login-password-very-long",
    AUTH_SIGNING_SECRET: "a-very-long-signing-secret-0123456789012345",
    EXECUTION_APPROVAL_SECRET: secret,
  });
}

describe("broker write authorization", () => {
  it("disables writes if the independent approval secret is missing or reused", async () => {
    expect(isExecutionApprovalConfigured(fixture(""))).toBe(false);
    expect(isExecutionApprovalConfigured(fixture("login-password-very-long"))).toBe(false);
    await expect(requireExecutionApproval("anything", fixture(""), new MemoryStateStore())).rejects.toThrow(/Trading is disabled/);
  });

  it("does not authorize a trade using the OAuth password", async () => {
    const store = new MemoryStateStore();
    await expect(requireExecutionApproval("login-password-very-long", fixture(), store)).rejects.toThrow(/incorrect/);
    await expect(requireExecutionApproval("independent-human-approval-secret", fixture(), store)).resolves.toBeUndefined();
  });

  it("rate-limits repeated wrong approvals before any broker write", async () => {
    const store = new MemoryStateStore();
    for (let i = 0; i < 8; i++) {
      await expect(requireExecutionApproval("invalid", fixture(), store)).rejects.toThrow(/incorrect/);
    }
    await expect(requireExecutionApproval("independent-human-approval-secret", fixture(), store)).rejects.toThrow(/Too many/);
  });
});
