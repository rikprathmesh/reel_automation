import type { Readable } from "node:stream";

/**
 * Storage abstraction. Keys are POSIX-style relative paths ("projects/<uuid>/v1/reel.mp4").
 * LocalStorage ships now; an S3-compatible store only needs to implement this interface
 * and be selected via STORAGE_DRIVER.
 */
export interface StorageAdapter {
  readonly driver: string;
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  stream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  stat(key: string): Promise<{ size: number; mtime: Date } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Absolute path when the store is a local disk shared with the Python services; null otherwise. */
  localPath(key: string): string | null;
}

export const STORAGE = Symbol("STORAGE");

/** Normalizes and validates a storage key; rejects absolute paths and traversal. */
export function assertKey(key: string): string {
  const k = key.split("\\").join("/").replace(/^\/+/, "");
  if (!k || k.split("/").some((p) => p === "" || p === "." || p === "..") || /^[a-zA-Z]:/.test(k)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return k;
}
