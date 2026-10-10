import { isExecutionApprovalConfigured, type RuntimeConfig } from "./config.js";
import { fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import { safeEqual } from "./web-utils.js";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/**
 * MCP app-only visibility is a discovery hint, not an authentication boundary.
 * Every broker write must require a separate human-held secret, even when a
 * caller already knows the one-time confirmation token and OAuth bearer token.
 * No approval secret is returned in tool results or persisted.
 */
export async function requireExecutionApproval(
  supplied: string,
  config: RuntimeConfig,
  store: StateStore,
): Promise<void> {
  if (!isExecutionApprovalConfigured(config)) {
    fail("EXECUTION_APPROVAL_REQUIRED", "EXECUTION_APPROVAL_SECRET is not configured. Trading is disabled.");
  }
  const rate = await store.increment("rate:execution-approval", WINDOW_MS);
  if (rate.count > MAX_ATTEMPTS) {
    fail("EXECUTION_APPROVAL_RATE_LIMITED", "Too many approval attempts. Try again later.", { retryAfterSeconds: rate.retryAfterSeconds });
  }
  if (typeof supplied !== "string" || !(await safeEqual(supplied, config.executionApprovalSecret))) {
    fail("EXECUTION_APPROVAL_INVALID", "Execution approval secret is incorrect.");
  }
  await store.delete("rate:execution-approval");
}
