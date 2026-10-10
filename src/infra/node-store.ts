import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStore, type Stored } from "./state.js";

/** Atomic single-process JSON persistence; do not run multiple Node replicas on the same file. */
export class LocalStore extends MemoryStore {
  private constructor(private readonly file: string) { super(); }
  static async open(file: string): Promise<LocalStore> {
    const store = new LocalStore(file);
    try {
      const content = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, Stored<unknown>>;
      store.values = new Map(Object.entries(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }
  protected async changed() {
    const folder = path.dirname(this.file);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(destination, JSON.stringify(Object.fromEntries(this.values)), { mode: 0o600 });
      await fs.rename(destination, this.file);
    } finally {
      await fs.rm(destination, { force: true }).catch(() => undefined);
    }
  }
}
