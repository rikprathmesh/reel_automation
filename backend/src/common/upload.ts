import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import { diskStorage } from "multer";

export type UploadKind = "video" | "image";

const SIGNATURES: { kind: UploadKind; ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { kind: "video", ext: "mp4", mime: "video/mp4", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" && !b.subarray(8, 12).toString("ascii").startsWith("qt") },
  { kind: "video", ext: "mov", mime: "video/quicktime", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" && b.subarray(8, 12).toString("ascii").startsWith("qt") },
  { kind: "video", ext: "webm", mime: "video/webm", test: (b) => b.readUInt32BE(0) === 0x1a45dfa3 },
  { kind: "image", ext: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: "image", ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "image", ext: "webp", mime: "image/webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

/** Multer options: stream to a temp file (no large buffers in RAM), hard size cap, single file. */
export function uploadOptions(maxMb: number) {
  return {
    storage: diskStorage({
      destination: os.tmpdir(),
      filename: (_req, _file, cb) => cb(null, `reelforge-upload-${crypto.randomUUID()}`),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 10 },
  };
}

/** Checks the real file signature (not the client-supplied name/mime). Deletes the temp file on rejection. */
export function sniffUpload(file: Express.Multer.File | undefined, allowed: UploadKind, maxMb: number): { ext: string; mime: string; path: string; size: number } {
  if (!file) throw new BadRequestException("No file uploaded (multipart field name must be \"file\")");
  if (file.size > maxMb * 1024 * 1024) {
    fs.rmSync(file.path, { force: true });
    throw new PayloadTooLargeException(`File exceeds ${maxMb} MB`);
  }
  const fd = fs.openSync(file.path, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const sig = SIGNATURES.find((s) => s.kind === allowed && s.test(head));
  if (!sig) {
    fs.rmSync(file.path, { force: true });
    throw new BadRequestException(allowed === "video" ? "Unsupported video. Upload MP4, MOV or WebM." : "Unsupported image. Upload PNG, JPEG or WebP.");
  }
  return { ext: sig.ext, mime: sig.mime, path: file.path, size: file.size };
}

export function safeBaseName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
}
