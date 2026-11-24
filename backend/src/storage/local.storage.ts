import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { assertKey, type StorageAdapter } from "./storage.types.ts";

export class LocalStorage implements StorageAdapter {
  readonly driver = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private abs(key: string): string {
    const p = path.resolve(this.root, assertKey(key));
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error("Storage key escapes the storage root");
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.abs(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    // write-then-rename so readers never see a half-written file
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
  }
  async read(key: string) {
    return fsp.readFile(this.abs(key));
  }
  async stream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return fs.createReadStream(this.abs(key), range);
  }
  async stat(key: string) {
    try {
      const s = await fsp.stat(this.abs(key));
      return s.isFile() ? { size: s.size, mtime: s.mtime } : null;
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await fsp.rm(this.abs(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await fsp.rm(this.abs(prefix), { recursive: true, force: true });
  }
  localPath(key: string) {
    return this.abs(key);
  }
}
