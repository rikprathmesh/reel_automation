import { Body, Controller, Delete, Get, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { MediaAssetsService, mediaUrl } from "../storage/storage.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { sniffUpload, uploadOptions } from "../common/upload.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { CATEGORIES, detectPlatform } from "./platform.ts";
import { ReferenceProcessor } from "./reference.processor.ts";

export { CATEGORIES };

const VIDEO_MAX_MB = Number(process.env.MAX_UPLOAD_MB ?? 300);

const Category = z.enum(CATEGORIES);

const CreateBody = z.object({
  urls: z.array(z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), "must be http(s)")).min(1).max(20),
  category: Category.optional(),
  notes: z.string().max(2000).optional(),
});
const UploadFields = z.object({ category: Category.optional(), title: z.string().max(200).optional(), sourceUrl: z.string().url().optional() });
const PatchBody = z.object({ category: Category.nullable().optional(), notes: z.string().max(2000).optional() });
const ListQuery = z.object({ status: z.string().optional(), category: Category.optional() });

@Controller("references")
class ReferencesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
    private readonly assets: MediaAssetsService,
  ) {}

  private async enqueue(id: string) {
    await this.prisma.referenceVideo.update({ where: { id }, data: { status: "queued", error: null } });
    await this.queues.enqueue("reference", "analyze", { referenceId: id }, { attempts: 1 });
    this.events.emit("reference", { id, status: "queued" });
  }

  @Get()
  async list(@Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    const rows = await this.prisma.referenceVideo.findMany({
      where: { deletedAt: null, ...(q.category ? { category: q.category } : {}), ...(q.status ? { status: q.status as never } : {}) },
      orderBy: { createdAt: "desc" },
      include: { analysis: { select: { summary: true } }, _count: { select: { stories: true } } },
    });
    return rows.map(({ _count, thumbnailKey, ...r }) => ({ ...r, thumbnailUrl: mediaUrl(thumbnailKey), storyCount: _count.stories }));
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const r = await this.prisma.referenceVideo.findFirst({
      where: { id, deletedAt: null },
      include: { analysis: true, videoAsset: { select: { storageKey: true } }, stories: { select: { id: true, title: true, createdAt: true } } },
    });
    if (!r) throw new NotFoundException("Reference not found");
    const { videoAsset, thumbnailKey, ...rest } = r;
    return { ...rest, thumbnailUrl: mediaUrl(thumbnailKey), videoUrl: mediaUrl(videoAsset?.storageKey) };
  }

  @Post()
  @Roles("owner", "editor")
  async create(@Body(zod(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() u: SessionUser) {
    const ids: string[] = [];
    for (const url of b.urls) {
      const r = await this.prisma.referenceVideo.create({ data: { url, platform: detectPlatform(url), source: "url", category: b.category, metadata: b.notes ? { notes: b.notes } : undefined } });
      await this.activity.record({ entityType: "reference", entityId: r.id, action: "added", message: `Reference added: ${url}`, actorUserId: u.id });
      await this.enqueue(r.id);
      ids.push(r.id);
    }
    return { ids };
  }

  /** Manual fallback when a platform blocks extraction: upload the reel file itself. */
  @Post("upload")
  @Roles("owner", "editor")
  @UseInterceptors(FileInterceptor("file", uploadOptions(VIDEO_MAX_MB)))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() raw: Record<string, string>, @CurrentUser() u: SessionUser) {
    const f = sniffUpload(file, "video", VIDEO_MAX_MB);
    const fields = zod(UploadFields).transform(raw);
    const replaceId = typeof raw.referenceId === "string" && /^[0-9a-f-]{36}$/i.test(raw.referenceId) ? raw.referenceId : null;
    const ref = replaceId
      ? await this.prisma.referenceVideo.update({ where: { id: replaceId }, data: { source: "upload", category: fields.category ?? undefined } })
      : await this.prisma.referenceVideo.create({ data: { url: fields.sourceUrl ?? null, platform: fields.sourceUrl ? detectPlatform(fields.sourceUrl) : "upload", source: "upload", category: fields.category, title: fields.title ?? null } });
    const asset = await this.assets.saveFromFile({ kind: "reference_video", key: `references/${ref.id}/source.${f.ext}`, filePath: f.path, mime: f.mime });
    await this.prisma.referenceVideo.update({ where: { id: ref.id }, data: { videoAssetId: asset.id, extractor: "upload" } });
    await this.activity.record({ entityType: "reference", entityId: ref.id, action: "uploaded", message: `Reference video uploaded (${(f.size / 1048576).toFixed(1)} MB)`, actorUserId: u.id });
    await this.enqueue(ref.id);
    return { id: ref.id };
  }

  @Patch(":id")
  @Roles("owner", "editor")
  async patch(@Param("id", ParseUUIDPipe) id: string, @Body(zod(PatchBody)) b: z.infer<typeof PatchBody>) {
    const cur = await this.prisma.referenceVideo.findFirstOrThrow({ where: { id, deletedAt: null } });
    await this.prisma.referenceVideo.update({
      where: { id },
      data: { category: b.category === undefined ? undefined : b.category, metadata: b.notes === undefined ? undefined : { ...((cur.metadata as object) ?? {}), notes: b.notes } },
    });
    return { ok: true };
  }

  @Post(":id/analyze")
  @Roles("owner", "editor")
  async reanalyze(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.prisma.referenceVideo.findFirstOrThrow({ where: { id, deletedAt: null } });
    await this.activity.record({ entityType: "reference", entityId: id, action: "reanalyze", message: "Re-analysis requested", actorUserId: u.id });
    await this.enqueue(id);
    return { ok: true };
  }

  @Delete(":id")
  @Roles("owner")
  async remove(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.prisma.referenceVideo.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.activity.record({ entityType: "reference", entityId: id, action: "deleted", message: "Reference removed (soft delete)", actorUserId: u.id });
    return { ok: true };
  }
}

@Module({ controllers: [ReferencesController], providers: [ReferenceProcessor] })
export class ReferencesModule {}
