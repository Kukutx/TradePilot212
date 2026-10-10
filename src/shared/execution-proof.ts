/** Browser/Worker-neutral, scoped, one-time approval proof. The raw secret is never a tool argument. */
export async function createExecutionApprovalProof(
  secret: string, operation: "order" | "cancel", confirmationToken: string,
): Promise<string> {
  if (!secret || !confirmationToken) throw new Error("Approval secret and confirmation token are required");
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  // Domain separation prevents cross-operation and cross-application proof reuse.
  const message = bytes.encode(`tradepilot212:execute:v1:${operation}:${confirmationToken}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
