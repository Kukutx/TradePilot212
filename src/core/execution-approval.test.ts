import { describe, expect, it } from "vitest";
import { createConfig, isExecutionApprovalConfigured } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { requireExecutionApproval } from "./execution-approval.js";
import { createExecutionApprovalProof } from "../shared/execution-proof.js";

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
    await expect(requireExecutionApproval("anything", "order", "test-token", fixture(""), new MemoryStateStore())).rejects.toThrow(/Trading is disabled/);
  });

  it("does not authorize a trade using the OAuth password", async () => {
    const store = new MemoryStateStore();
    const wrongProof = await createExecutionApprovalProof("login-password-very-long", "order", "test-token");
    await expect(requireExecutionApproval(wrongProof, "order", "test-token", fixture(), store)).rejects.toThrow(/incorrect/);
    const validProof = await createExecutionApprovalProof("independent-human-approval-secret", "order", "test-token");
    await expect(requireExecutionApproval(validProof, "order", "test-token", fixture(), store)).resolves.toBeUndefined();
    await expect(requireExecutionApproval(validProof, "cancel", "test-token", fixture(), store)).rejects.toThrow(/incorrect/);
  });

  it("rate-limits repeated wrong approvals before any broker write", async () => {
    const store = new MemoryStateStore();
    for (let i = 0; i < 8; i++) {
      await expect(requireExecutionApproval("invalid", "order", "test-token", fixture(), store)).rejects.toThrow(/incorrect/);
    }
    const validProof = await createExecutionApprovalProof("independent-human-approval-secret", "order", "test-token");
    await expect(requireExecutionApproval(validProof, "order", "test-token", fixture(), store)).rejects.toThrow(/Too many/);
  });
});
