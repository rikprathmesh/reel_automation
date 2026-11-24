import { Controller, Get, Module, NotFoundException, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { mediaUrl } from "../storage/storage.module.ts";
import { zod } from "../common/zod.pipe.ts";

const StoryQuery = z.object({ category: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const ProjectQuery = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

/** Read APIs for the Content Studio (stories/scripts/scenes) and video projects. */
@Controller()
class ContentController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("stories")
  list(@Query(zod(StoryQuery)) q: z.infer<typeof StoryQuery>) {
    return this.prisma.story.findMany({
      where: { deletedAt: null, ...(q.category ? { category: q.category as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { _count: { select: { scripts: true, projects: true } } },
    });
  }

  @Get("stories/:id")
  async story(@Param("id", ParseUUIDPipe) id: string) {
    const s = await this.prisma.story.findFirst({
      where: { id, deletedAt: null },
      include: {
        references: { select: { id: true, url: true, title: true } },
        scripts: {
          orderBy: { version: "desc" },
          include: { scenes: { orderBy: { index: "asc" }, include: { characters: { include: { character: { select: { id: true, name: true } } } } } } },
        },
        projects: { select: { id: true, status: true, createdAt: true } },
      },
    });
    if (!s) throw new NotFoundException("Story not found");
    return s;
  }

  @Get("projects")
  async projects(@Query(zod(ProjectQuery)) q: z.infer<typeof ProjectQuery>) {
    const rows = await this.prisma.videoProject.findMany({
      where: { deletedAt: null, ...(q.status ? { status: q.status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: {
        story: { select: { id: true, title: true, category: true, language: true } },
        versions: { orderBy: { versionNo: "desc" }, take: 1, include: { thumbnailAsset: { select: { storageKey: true } }, videoAsset: { select: { storageKey: true } } } },
        jobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    return rows.map(({ versions, jobs, ...p }) => {
      const v = versions[0];
      return {
        ...p,
        latestVersion: v ? { id: v.id, versionNo: v.versionNo, status: v.status, durationSec: v.durationSec, videoUrl: mediaUrl(v.videoAsset?.storageKey), thumbnailUrl: mediaUrl(v.thumbnailAsset?.storageKey), createdAt: v.createdAt } : null,
        latestJob: jobs[0] ?? null,
      };
    });
  }

  @Get("projects/:id")
  async project(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.prisma.videoProject.findFirst({
      where: { id, deletedAt: null },
      include: {
        story: true,
        jobs: { orderBy: { createdAt: "desc" } },
        versions: {
          orderBy: { versionNo: "desc" },
          include: {
            videoAsset: { select: { storageKey: true } },
            thumbnailAsset: { select: { storageKey: true } },
            approvals: { orderBy: { decidedAt: "desc" }, include: { user: { select: { displayName: true } } } },
            publishingJobs: { include: { published: true } },
            script: { include: { scenes: { orderBy: { index: "asc" } } } },
          },
        },
        assets: { where: { deletedAt: null }, select: { id: true, kind: true, storageKey: true, durationSec: true, meta: true } },
      },
    });
    if (!p) throw new NotFoundException("Project not found");
    return {
      ...p,
      versions: p.versions.map(({ videoAsset, thumbnailAsset, ...v }) => ({ ...v, videoUrl: mediaUrl(videoAsset?.storageKey), thumbnailUrl: mediaUrl(thumbnailAsset?.storageKey) })),
      assets: p.assets.map(({ storageKey, ...a }) => ({ ...a, url: mediaUrl(storageKey) })),
    };
  }

  @Get("jobs")
  jobs() {
    return this.prisma.videoGenerationJob.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { project: { select: { id: true, story: { select: { title: true } } } } } });
  }

  @Get("stats")
  async stats() {
    const [byStatus, failedJobs, reels] = await Promise.all([
      this.prisma.videoProject.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.videoGenerationJob.count({ where: { status: "failed" } }),
      this.prisma.videoProject.count({ where: { deletedAt: null } }),
    ]);
    const n = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    return { total: reels, awaitingReview: n("awaiting_review"), approved: n("approved"), rejected: n("rejected"), published: n("published"), generating: n("generating") + n("queued"), failedJobs };
  }
}

@Module({ controllers: [ContentController] })
export class ContentModule {}
