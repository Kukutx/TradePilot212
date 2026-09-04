export interface StoredValue<T> { value: T; expiresAt?: number }

export interface StateStore {
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  consume<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  increment(key: string, windowMs: number, now?: number): Promise<{ count: number; retryAfterSeconds: number }>;
}

export class MemoryStateStore implements StateStore {
  protected readonly values = new Map<string, StoredValue<unknown>>();
  private queue: Promise<void> = Promise.resolve();

  protected async changed(): Promise<void> {}
  protected expired(item: StoredValue<unknown> | undefined, now = Date.now()): boolean {
    return item?.expiresAt !== undefined && item.expiresAt <= now;
  }
  protected serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    await this.serialize(async () => { this.values.set(key, { value, ...(expiresAt === undefined ? {} : { expiresAt }) }); await this.changed(); });
  }
  async get<T>(key: string): Promise<T | undefined> {
    return this.serialize(async () => {
      const item = this.values.get(key);
      if (this.expired(item)) { this.values.delete(key); await this.changed(); return undefined; }
      return item?.value as T | undefined;
    });
  }
  async consume<T>(key: string): Promise<T | undefined> {
    return this.serialize(async () => {
      const item = this.values.get(key);
      if (!item || this.expired(item)) { if (item) { this.values.delete(key); await this.changed(); } return undefined; }
      this.values.delete(key); await this.changed(); return item.value as T;
    });
  }
  async delete(key: string): Promise<void> { await this.serialize(async () => { this.values.delete(key); await this.changed(); }); }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.serialize(async () => {
      let dirty = false; const result: Array<{ key: string; value: T }> = [];
      for (const [key, item] of this.values) {
        if (this.expired(item)) { this.values.delete(key); dirty = true; }
        else if (key.startsWith(prefix)) result.push({ key, value: item.value as T });
      }
      if (dirty) await this.changed(); return result;
    });
  }
  async increment(key: string, windowMs: number, now = Date.now()): Promise<{ count: number; retryAfterSeconds: number }> {
    return this.serialize(async () => {
      const item = this.values.get(key); const current = !item || this.expired(item, now) ? 0 : Number(item.value);
      const expiresAt = !item || this.expired(item, now) ? now + windowMs : item.expiresAt!;
      const count = current + 1; this.values.set(key, { value: count, expiresAt }); await this.changed();
      return { count, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)) };
    });
  }
}
