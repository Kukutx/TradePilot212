import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the tool call a read is made for asks of it: `signal` aborts once the client cancels the call, and `page` is
 * told of each history page read, for the client's progress bar. A read made outside a tool call (the scheduler, a
 * test) has none.
 */
export interface ReadWatch {
  signal?: AbortSignal;
  page?: () => void;
}

const watches = new AsyncLocalStorage<ReadWatch>();

/** Runs `run` with `watch` as the watch of every read it makes, down through its awaits. */
export function watchingReads<T>(watch: ReadWatch, run: () => T): T {
  return watches.run(watch, run);
}

/** The watch of the tool call this read is made for, if any. */
export function readWatch(): ReadWatch | undefined {
  return watches.getStore();
}

/** Whether the tool call this read is made for was cancelled: a long read stops at its next page. */
export function readCancelled(): boolean {
  return watches.getStore()?.signal?.aborted === true;
}

/**
 * The watch of a tool call from the SDK's request context: its abort signal, and when the client asked for progress
 * (a progressToken in `_meta`), a notifications/progress per history page read. A notification that fails to send is
 * dropped: progress never fails a read.
 */
export function toolCallWatch(ctx: unknown): ReadWatch {
  const request = (ctx as { mcpReq?: { signal?: AbortSignal; _meta?: { progressToken?: unknown }; notify?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void> } } | undefined)?.mcpReq;
  if (!request) return {};
  const token = request._meta?.progressToken;
  const notify = request.notify;
  const watch: ReadWatch = request.signal ? { signal: request.signal } : {};
  if ((typeof token === "string" || typeof token === "number") && notify) {
    let pages = 0;
    watch.page = () => {
      pages += 1;
      if (request.signal?.aborted) return;
      notify({ method: "notifications/progress", params: { progressToken: token, progress: pages, message: `Read ${pages} history page${pages === 1 ? "" : "s"}` } }).catch(() => undefined);
    };
  }
  return watch;
}
