import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStateStore, type StoredValue } from "../../core/state-store.js";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JSON-file state shared safely between processes, for example Claude Desktop and Claude Code both
 * running the stdio server on one data directory. Every operation takes an exclusive lock file,
 * reloads the file when another process changed it, and writes atomically, so plan locks and
 * confirmation tokens hold across processes and one process never overwrites another's changes.
 */
export class FileStateStore extends MemoryStateStore {
  private loadedVersion = "";
  private constructor(private readonly file: string) { super(); }

  static async open(file: string): Promise<FileStateStore> {
    const store = new FileStateStore(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await store.withFileLock(() => store.reloadIfChanged());
    return store;
  }

  private async version(): Promise<string> {
    try {
      const stat = await fs.stat(this.file);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async reloadIfChanged(): Promise<void> {
    const version = await this.version();
    if (version === this.loadedVersion) return;
    this.values.clear();
    if (version) {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, StoredValue<unknown>>;
      for (const [key, value] of Object.entries(parsed)) this.values.set(key, value);
    }
    this.loadedVersion = version;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await (await fs.open(lock, "wx")).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A lock left behind by a crashed process is taken over once it is clearly stale.
        const stat = await fs.stat(lock).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
        else if (Date.now() > deadline) throw new Error(`TradePilot state is locked by another process (${lock})`);
        else await sleep(15);
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }

  protected override serialize<T>(operation: () => Promise<T>): Promise<T> {
    return super.serialize(() => this.withFileLock(async () => {
      await this.reloadIfChanged();
      return operation();
    }));
  }

  protected override async changed(): Promise<void> {
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(Object.fromEntries(this.values)), "utf8");
    await fs.rename(temp, this.file);
    this.loadedVersion = await this.version();
  }
}
