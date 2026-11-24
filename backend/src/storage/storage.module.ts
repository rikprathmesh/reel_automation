import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Controller, Get, Global, Inject, Injectable, Module, NotFoundException, BadRequestException, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import type { AppEnv } from "../config/env.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { MediaKind, Prisma } from "../generated/prisma/client.ts";
import { LocalStorage } from "./local.storage.ts";
import { STORAGE, assertKey, type StorageAdapter } from "./storage.types.ts";

export function mediaUrl(key: string | null | undefined): string | null {
  return key ? `/media/${key.split("/").map(encodeURIComponent).join("/")}` : null;
}

/** Stores bytes and registers them as a MediaAsset (path + metadata in Postgres, bytes on disk). */
@Injectable()
export class MediaAssetsService {
  constructor(@Inject(STORAGE) private readonly storage: StorageAdapter, private readonly prisma: PrismaService) {}

  async save(input: { kind: MediaKind; key: string; data: Buffer; mime: string; projectId?: string | null; provider?: string | null; meta?: Prisma.InputJsonValue; width?: number; height?: number; durationSec?: number }) {
    const key = assertKey(input.key);
    await this.storage.put(key, input.data);
    const sha256 = crypto.createHash("sha256").update(input.data).digest("hex");
    const data = {
      kind: input.kind, mime: input.mime, bytes: BigInt(input.data.length), sha256,
      projectId: input.projectId ?? null, provider: input.provider ?? null, meta: input.meta,
      width: input.width, height: input.height, durationSec: input.durationSec, deletedAt: null,
    };
    return this.prisma.mediaAsset.upsert({ where: { storageKey: key }, create: { storageKey: key, ...data }, update: data });
  }

  /** Registers a file that another service (Python) already wrote into shared storage. */
  async registerExisting(input: { kind: MediaKind; key: string; mime: string; projectId?: string | null; provider?: string | null; meta?: Prisma.InputJsonValue; durationSec?: number }) {
    const key = assertKey(input.key);
    const abs = this.storage.localPath(key);
    if (!abs || !fs.existsSync(abs)) throw new Error(`File not found in storage: ${key}`);
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = crypto.createHash("sha256");
      fs.createReadStream(abs).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
    });
    const data = {
      kind: input.kind, mime: input.mime, bytes: BigInt(fs.statSync(abs).size), sha256, projectId: input.projectId ?? null,
      provider: input.provider ?? null, meta: input.meta, durationSec: input.durationSec, deletedAt: null,
    };
    return this.prisma.mediaAsset.upsert({ where: { storageKey: key }, create: { storageKey: key, ...data }, update: data });
  }

  /** Moves an already-validated temp file into storage (streamed hash, no full read into memory) and registers it. */
  async saveFromFile(input: { kind: MediaKind; key: string; filePath: string; mime: string; projectId?: string | null; meta?: Prisma.InputJsonValue }) {
    const key = assertKey(input.key);
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = crypto.createHash("sha256");
      fs.createReadStream(input.filePath).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
    });
    const size = fs.statSync(input.filePath).size;
    const dest = this.storage.localPath(key);
    if (!dest) throw new Error("saveFromFile requires local storage");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(input.filePath, dest);
    } catch {
      fs.copyFileSync(input.filePath, dest); // temp dir on another drive
      fs.rmSync(input.filePath, { force: true });
    }
    const data = { kind: input.kind, mime: input.mime, bytes: BigInt(size), sha256, projectId: input.projectId ?? null, meta: input.meta, deletedAt: null };
    return this.prisma.mediaAsset.upsert({ where: { storageKey: key }, create: { storageKey: key, ...data }, update: data });
  }
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ass: "text/plain", srt: "text/plain", json: "application/json",
};

/** Authenticated file streaming with HTTP Range support (needed for video seeking). */
@Controller("media")
@SkipThrottle()
export class MediaController {
  constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

  @Get("*key")
  async get(@Req() req: Request, @Res() res: Response) {
    let key: string;
    try {
      key = assertKey(decodeURIComponent(req.path.replace(/^\/api\/media\//, "")));
    } catch {
      throw new BadRequestException("Invalid media path");
    }
    const st = await this.storage.stat(key);
    if (!st) throw new NotFoundException("File not found");
    res.setHeader("Content-Type", MIME[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const m = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.setHeader("Content-Range", `bytes */${st.size}`);
        return res.status(416).end();
      }
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      return (await this.storage.stream(key, { start, end })).pipe(res);
    }
    res.setHeader("Content-Length", String(st.size));
    return (await this.storage.stream(key)).pipe(res);
  }
}

@Global()
@Module({
  controllers: [MediaController],
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): StorageAdapter => {
        const driver = config.get("STORAGE_DRIVER", { infer: true });
        if (driver === "local") return new LocalStorage(config.get("STORAGE_ROOT", { infer: true }));
        throw new Error(`Unsupported STORAGE_DRIVER ${driver}`);
      },
    },
    MediaAssetsService,
  ],
  exports: [STORAGE, MediaAssetsService],
})
export class StorageModule {}
