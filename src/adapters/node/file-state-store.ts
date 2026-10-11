import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStateStore, type StoredValue } from "../../core/state-store.js";

const LOCK_STALE_MS = 10_000;
// Longer than the stale threshold, so a waiter outlives a lock left by a crashed process and takes it over.
const LOCK_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JSON-file state shared safely between processes, for example Claude Desktop and Claude Code both
 * running the stdio server on one data directory. Every operation takes an exclusive lock file,
 * reloads the file when another process changed it, and writes atomically, so plan locks and
 * confirmation tokens hold across processes and one process never overwrites another's changes.
 * The previous good file is kept as `.bak`; an unreadable file is set aside and the backup loaded.
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
      const parsed = await this.read(this.file) ?? await this.recover();
      for (const [key, value] of Object.entries(parsed)) this.values.set(key, value);
    }
    this.loadedVersion = await this.version();
  }

  private async read(file: string): Promise<Record<string, StoredValue<unknown>> | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, StoredValue<unknown>> : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  /** The state file cannot be parsed: keep it for inspection and continue from the last good copy. */
  private async recover(): Promise<Record<string, StoredValue<unknown>>> {
    const aside = `${this.file}.corrupt-${Date.now()}`;
    await fs.rename(this.file, aside);
    const backup = await this.read(`${this.file}.bak`);
    console.error(JSON.stringify({ message: "TradePilot state file was unreadable", movedTo: aside, restored: backup ? "backup" : "empty" }));
    if (backup) await this.write(backup);
    return backup ?? {};
  }

  private async write(values: Record<string, StoredValue<unknown>>): Promise<void> {
    const temp = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify(values), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The file being replaced was read successfully, so it is the backup for the next failure.
    if (this.loadedVersion) await fs.copyFile(this.file, `${this.file}.bak`).catch(() => {});
    await fs.rename(temp, this.file);
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
    await this.write(Object.fromEntries(this.values));
    this.loadedVersion = await this.version();
  }
}
