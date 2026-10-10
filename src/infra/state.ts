export interface Stored<T> { value: T; expiresAt?: number }
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  take<T>(key: string): Promise<T | undefined>;
  remove(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  increment(key: string, durationMs: number): Promise<number>;
  /** Atomically allocates an API request slot; null means the wait budget was exceeded. */
  reserve(key: string, spacingMs: number, nowMs: number, maxWaitMs: number): Promise<number | null>;
  /** Acquire/release an exclusive lease with owner compare-and-swap. */
  claim(key: string, owner: string, expiresAt: number): Promise<boolean>;
  release(key: string, owner: string): Promise<boolean>;
}

/** Single-owner memory store; atomic operations are serialized for concurrent requests. */
export class MemoryStore implements StateStore {
  protected values = new Map<string, Stored<unknown>>();
  private queue: Promise<void> = Promise.resolve();
  protected async changed(): Promise<void> {}
  protected locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  protected valid(key: string, now = Date.now()): Stored<unknown> | undefined {
    const item = this.values.get(key);
    if (item?.expiresAt !== undefined && item.expiresAt <= now) {
      this.values.delete(key);
      return undefined;
    }
    return item;
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.locked(async () => this.valid(key)?.value as T | undefined);
  }
  put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    return this.locked(async () => {
      this.values.set(key, { value, ...(expiresAt ? { expiresAt } : {}) });
      await this.changed();
    });
  }
  take<T>(key: string): Promise<T | undefined> {
    return this.locked(async () => {
      const value = this.valid(key)?.value as T | undefined;
      this.values.delete(key);
      await this.changed();
      return value;
    });
  }
  remove(key: string): Promise<void> {
    return this.locked(async () => { this.values.delete(key); await this.changed(); });
  }
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.locked(async () => {
      const rows: Array<{ key: string; value: T }> = [];
      for (const key of this.values.keys()) {
        const entry = this.valid(key);
        if (entry && key.startsWith(prefix)) rows.push({ key, value: entry.value as T });
      }
      return rows;
    });
  }
  claim(key: string, owner: string, expiresAt: number): Promise<boolean> {
    return this.locked(async () => {
      if(!owner||expiresAt<=Date.now())throw new Error("Invalid broker execution lease");
      if(this.valid(key))return false;
      this.values.set(key,{value:owner,expiresAt});
      await this.changed();
      return true;
    });
  }
  release(key: string, owner: string): Promise<boolean> {
    return this.locked(async () => {
      if(this.valid(key)?.value!==owner)return false;
      this.values.delete(key);
      await this.changed();
      return true;
    });
  }
  reserve(key: string, spacingMs: number, nowMs: number, maxWaitMs: number): Promise<number | null> {
    return this.locked(async () => {
      if (!Number.isFinite(nowMs) || !Number.isFinite(spacingMs) || spacingMs <= 0 || maxWaitMs < 0)
        throw new Error("Invalid broker reservation");
      const previous = this.valid(key, nowMs)?.value;
      const next = typeof previous === "number" && Number.isFinite(previous) ? previous : nowMs;
      const allocatedAt = Math.max(nowMs, next);
      if (allocatedAt - nowMs > maxWaitMs) return null;
      this.values.set(key, { value: allocatedAt + spacingMs, expiresAt: allocatedAt + spacingMs + 60_000 });
      await this.changed();
      return allocatedAt;
    });
  }
  increment(key: string, durationMs: number): Promise<number> {
    return this.locked(async () => {
      const previous = this.valid(key);
      const count = previous ? Number(previous.value) + 1 : 1;
      this.values.set(key, { value: count, expiresAt: previous?.expiresAt ?? Date.now() + durationMs });
      await this.changed();
      return count;
    });
  }
}
