import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStateStore, type StoredValue } from "../../core/state-store.js";

export class FileStateStore extends MemoryStateStore {
  private constructor(private readonly file: string) { super(); }
  static async open(file: string): Promise<FileStateStore> {
    const store = new FileStateStore(file);
    try { const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, StoredValue<unknown>>; for (const [k,v] of Object.entries(parsed)) store.values.set(k,v); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return store;
  }
  protected override async changed(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(Object.fromEntries(this.values)), "utf8");
    await fs.rename(temp, this.file);
  }
}
