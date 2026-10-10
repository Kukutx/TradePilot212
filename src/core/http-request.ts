/** Fail-closed MCP HTTP request bounding, including chunked requests without Content-Length. */
export class RequestTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`MCP request body exceeds ${maxBytes} bytes`);
    this.name = "RequestTooLargeError";
  }
}

export async function boundedMcpRequest(request: Request, maxBytes = 1_048_576): Promise<Request> {
  const advertised = request.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
      throw new RequestTooLargeError(maxBytes);
  }
  if (request.method !== "POST" || !request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new RequestTooLargeError(maxBytes);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    signal: request.signal,
  });
}
