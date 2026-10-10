export interface Stored<T> { value: T; expiresAt?: number }
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  take<T>(key: string): Promise<T | undefined>;
  remove(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  increment(key: string, durationMs: number): Promise<number>;
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
