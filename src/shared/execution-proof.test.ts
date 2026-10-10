import { describe, expect, it } from "vitest";
import { createExecutionApprovalProof } from "./execution-proof.js";

describe("scoped execution approval proofs", () => {
  it("generates stable URL-safe HMAC-SHA256 without exposing the secret", async () => {
    const secret = "independent-human-approval-secret";
    const proof = await createExecutionApprovalProof(secret, "order", "confirmation-token-1");
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof).not.toContain(secret);
    expect(await createExecutionApprovalProof(secret, "order", "confirmation-token-1")).toBe(proof);
  });
  it("binds proofs to exact operation, token and secret", async () => {
    const first = await createExecutionApprovalProof("secret-1", "order", "token-1");
    expect(await createExecutionApprovalProof("secret-1", "cancel", "token-1")).not.toBe(first);
    expect(await createExecutionApprovalProof("secret-1", "order", "token-2")).not.toBe(first);
    expect(await createExecutionApprovalProof("secret-2", "order", "token-1")).not.toBe(first);
  });
});
