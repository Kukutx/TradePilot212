export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = ""; for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const a = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const b = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const x = new Uint8Array(a), y = new Uint8Array(b); let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}
