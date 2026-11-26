import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import crypto from "node:crypto";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { ProductionModule } from "../production/production.module.ts";
import { ProductionService } from "../production/production.service.ts";
import { mediaUrl } from "../storage/storage.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { Prisma } from "../generated/prisma/client.ts";

const Platform = z.enum(["youtube", "instagram"]);
const ApproveBody = z.object({
  platforms: z.array(Platform).min(1).max(2),
  scheduledFor: z.string().datetime({ offset: true }).nullable().default(null),
  notes: z.string().max(1000).optional(),
});
const RejectBody = z.object({ notes: z.string().max(1000).optional() });
const ChangesBody = z.object({ feedback: z.string().trim().min(5).max(2000) });
const MetadataBody = z.object({
  youtubeTitle: z.string().trim().min(1).max(100),
  youtubeDescription: z.string().max(5000),
  instagramCaption: z.string().max(2200),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(30),
});
const ListQuery = z.object({ status: z.enum(["ready", "approved", "rejected", "changes_requested", "all"]).default("ready") });

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

/**
 * Review Studio. The approval gate lives here and in the publishing worker (which re-verifies it):
 *  - only a version in status "ready" (or "approved", to add a platform) can be approved;
 *  - approval, its user and timestamp are written in the same SERIALIZABLE transaction that creates publishing jobs;
 *  - rejecting cancels every not-yet-uploaded publishing job for that version.
 */
@Controller()
class ReviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
    private readonly production: ProductionService,
  ) {}

  @Get("review")
  async list(@Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    const versions = await this.prisma.videoVersion.findMany({
      where: { ...(q.status === "all" ? { status: { in: ["ready", "approved", "rejected", "changes_requested"] } } : { status: q.status }), project: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        videoAsset: { select: { storageKey: true } },
        thumbnailAsset: { select: { storageKey: true } },
        script: { include: { scenes: { orderBy: { index: "asc" }, select: { id: true, index: true, title: true, description: true, dialogue: true, onScreenText: true } } } },
        sceneJobs: { orderBy: { index: "asc" }, select: { sceneId: true, index: true, status: true, imageKey: true, clipKey: true, reusedFromId: true, timings: true, error: true } },
        project: { include: { story: true } },
        approvals: { orderBy: { decidedAt: "desc" }, take: 1, include: { user: { select: { displayName: true } } } },
        publishingJobs: { select: { id: true, platform: true, status: true, scheduledFor: true, published: { select: { url: true } } } },
      },
    });
    return versions.map(({ videoAsset, thumbnailAsset, sceneJobs, ...v }) => ({
      ...v, videoUrl: mediaUrl(videoAsset?.storageKey), thumbnailUrl: mediaUrl(thumbnailAsset?.storageKey),
      sceneJobs: sceneJobs.map(({ imageKey, clipKey, ...r }) => ({ ...r, imageUrl: mediaUrl(imageKey), clipUrl: mediaUrl(clipKey), reused: Boolean(r.reusedFromId) })),
    }));
  }

  @Post("versions/:id/approve")
  @Roles("owner")
  async approve(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ApproveBody)) b: z.infer<typeof ApproveBody>, @CurrentUser() u: SessionUser) {
    const scheduledFor = b.scheduledFor ? new Date(b.scheduledFor) : null;
    if (scheduledFor && scheduledFor.getTime() < Date.now() - 60_000) throw new BadRequestException("Scheduled time is in the past");

    const result = await this.prisma.$transaction(async (tx) => {
      const v = await tx.videoVersion.findUnique({ where: { id }, include: { project: true } });
      if (!v || v.project.deletedAt) throw new NotFoundException("Version not found");
      if (!["ready", "approved"].includes(v.status)) throw new ConflictException(`Version is "${v.status}" and can't be approved`);
      if (!v.videoAssetId) throw new ConflictException("Version has no rendered video");
      const approval = await tx.approval.create({ data: { versionId: id, decision: "approved", userId: u.id, platforms: b.platforms, notes: b.notes } });
      await tx.videoVersion.update({ where: { id }, data: { status: "approved" } });
      await tx.videoProject.update({ where: { id: v.projectId }, data: { status: "approved" } });
      const jobs = [];
      for (const platform of b.platforms) {
        const existing = await tx.publishingJob.findUnique({ where: { versionId_platform: { versionId: id, platform } } });
        if (existing && existing.status !== "cancelled") continue; // already queued/published for this platform — never twice
        const data = { approvalId: approval.id, status: scheduledFor ? ("scheduled" as const) : ("queued" as const), scheduledFor, lastError: Prisma.DbNull, attempts: 0 };
        jobs.push(existing
          ? await tx.publishingJob.update({ where: { id: existing.id }, data })
          : await tx.publishingJob.create({ data: { versionId: id, platform, idempotencyKey: crypto.randomUUID(), ...data } }));
      }
      return { approval, jobs, projectId: v.projectId };
    }, SERIALIZABLE);

    for (const job of result.jobs) {
      const delay = job.scheduledFor ? Math.max(0, job.scheduledFor.getTime() - Date.now()) : 0;
      const bullJobId = await this.queues.enqueue("publishing", "publish", { publishingJobId: job.id }, { delay, attempts: 3, backoff: { type: "exponential", delay: 120_000 }, jobId: `publish-${job.id}-${Date.now()}` });
      await this.prisma.publishingJob.update({ where: { id: job.id }, data: { bullJobId } });
    }
    this.events.emit("project", { id: result.projectId, status: "approved" });
    await this.activity.record({
      entityType: "version", entityId: id, action: "approved", actorUserId: u.id,
      message: `Approved by ${u.email} for ${b.platforms.join(" + ")}${scheduledFor ? ` (scheduled ${scheduledFor.toISOString()})` : ""}`,
      data: { approvalId: result.approval.id, platforms: b.platforms },
    });
    return { ok: true, approvalId: result.approval.id, publishingJobs: result.jobs.map((j) => ({ id: j.id, platform: j.platform, status: j.status })) };
  }

  @Post("versions/:id/reject")
  @Roles("owner")
  async reject(@Param("id", ParseUUIDPipe) id: string, @Body(zod(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: SessionUser) {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const v = await tx.videoVersion.findUnique({ where: { id } });
      if (!v) throw new NotFoundException("Version not found");
      if (!["ready", "approved", "changes_requested"].includes(v.status)) throw new ConflictException(`Version is "${v.status}" and can't be rejected`);
      const uploading = await tx.publishingJob.count({ where: { versionId: id, status: { in: ["uploading", "published"] } } });
      if (uploading) throw new ConflictException("This version is already uploading/published and can't be rejected");
      await tx.approval.create({ data: { versionId: id, decision: "rejected", userId: u.id, platforms: [], notes: b.notes } });
      await tx.videoVersion.update({ where: { id }, data: { status: "rejected" } });
      await tx.videoProject.update({ where: { id: v.projectId }, data: { status: "rejected" } });
      const pending = await tx.publishingJob.findMany({ where: { versionId: id, status: { in: ["queued", "scheduled", "failed", "manual_required"] } } });
      await tx.publishingJob.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: "cancelled", lastError: { reason: "version rejected" } } });
      return pending;
    }, SERIALIZABLE);
    for (const p of cancelled) if (p.bullJobId) await this.queues.cancel("publishing", p.bullJobId);
    await this.activity.record({ entityType: "version", entityId: id, action: "rejected", actorUserId: u.id, message: `Rejected by ${u.email}${b.notes ? `: ${b.notes}` : ""}${cancelled.length ? ` — ${cancelled.length} publishing job(s) cancelled` : ""}` });
    return { ok: true, cancelledPublishingJobs: cancelled.length };
  }

  /** Feedback → revised story script (LLM) → new render → back into the review queue. */
  @Post("versions/:id/request-changes")
  @Roles("owner", "editor")
  async requestChanges(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ChangesBody)) b: z.infer<typeof ChangesBody>, @CurrentUser() u: SessionUser) {
    const v = await this.prisma.$transaction(async (tx) => {
      const ver = await tx.videoVersion.findUnique({ where: { id }, include: { project: true } });
      if (!ver) throw new NotFoundException("Version not found");
      if (ver.status !== "ready") throw new ConflictException(`Version is "${ver.status}"; only a version awaiting review can get change requests`);
      await tx.approval.create({ data: { versionId: id, decision: "changes_requested", userId: u.id, platforms: [], notes: b.feedback } });
      await tx.videoVersion.update({ where: { id }, data: { status: "changes_requested" } });
      await tx.videoProject.update({ where: { id: ver.projectId }, data: { status: "changes_requested" } });
      return ver;
    }, SERIALIZABLE);
    await this.queues.enqueue("production", "revise", { projectId: v.projectId, storyId: v.project.storyId, feedback: b.feedback }, { attempts: 2 });
    await this.activity.record({ entityType: "version", entityId: id, action: "changes_requested", actorUserId: u.id, message: `Changes requested: ${b.feedback.slice(0, 200)}` });
    return { ok: true };
  }

  /** Re-render the same story (new images/voices) as a new version. */
  @Post("projects/:id/regenerate")
  @Roles("owner", "editor")
  async regenerate(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    const p = await this.prisma.videoProject.findFirst({ where: { id, deletedAt: null } });
    if (!p) throw new NotFoundException("Project not found");
    if (["generating", "publishing", "published"].includes(p.status)) throw new ConflictException(`Project is "${p.status}"`);
    await this.production.rerender(id);
    await this.activity.record({ entityType: "project", entityId: id, action: "regenerate", actorUserId: u.id, message: "Regeneration requested" });
    return { ok: true };
  }

  /**
   * Regenerates ONE scene: a new version that redraws only that scene (new seed) and reuses every other finished scene,
   * then re-merges. The new version needs its own review and approval; the old one is superseded when it is ready.
   */
  @Post("versions/:id/scenes/:sceneId/regenerate")
  @Roles("owner", "editor")
  async regenerateScene(@Param("id", ParseUUIDPipe) id: string, @Param("sceneId", ParseUUIDPipe) sceneId: string, @CurrentUser() u: SessionUser) {
    const v = await this.prisma.videoVersion.findUnique({ where: { id }, include: { project: true, sceneJobs: { where: { sceneId }, select: { index: true } }, publishingJobs: { select: { status: true } } } });
    if (!v || v.project.deletedAt) throw new NotFoundException("Version not found");
    if (!v.sceneJobs.length) throw new BadRequestException("This version was rendered before scene jobs existed (or the scene is not part of it): use Regenerate for the whole reel");
    if (["generating", "queued", "publishing"].includes(v.project.status)) throw new ConflictException(`Project is "${v.project.status}"`);
    if (v.publishingJobs.some((j) => ["uploading", "published"].includes(j.status))) throw new ConflictException("This version is already uploading/published");
    await this.production.rerenderScenes(v.projectId, id, [sceneId]);
    await this.activity.record({ entityType: "version", entityId: id, action: "scene_regenerate", actorUserId: u.id, message: `Scene ${v.sceneJobs[0]!.index + 1} of v${v.versionNo} queued for regeneration; other scenes are reused` });
    return { ok: true };
  }

  /** Title/caption/hashtag edits apply to the version's script without a re-render. */
  @Patch("versions/:id/metadata")
  @Roles("owner", "editor")
  async metadata(@Param("id", ParseUUIDPipe) id: string, @Body(zod(MetadataBody)) b: z.infer<typeof MetadataBody>, @CurrentUser() u: SessionUser) {
    const v = await this.prisma.videoVersion.findUnique({ where: { id }, include: { publishingJobs: true } });
    if (!v) throw new NotFoundException("Version not found");
    if (v.publishingJobs.some((j) => ["uploading", "published"].includes(j.status))) throw new ConflictException("Already publishing/published — metadata is locked");
    await this.prisma.storyScript.update({ where: { id: v.scriptId }, data: { ...b, hashtags: b.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")) } });
    await this.activity.record({ entityType: "version", entityId: id, action: "metadata_edited", actorUserId: u.id, message: `Title/caption edited: "${b.youtubeTitle}"` });
    return { ok: true };
  }

  /** Manual deletion (soft). Published projects keep their history and can't be deleted. */
  @Delete("projects/:id")
  @Roles("owner")
  async remove(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    const p = await this.prisma.videoProject.findFirst({ where: { id, deletedAt: null }, include: { versions: { include: { publishingJobs: true } } } });
    if (!p) throw new NotFoundException("Project not found");
    if (p.versions.some((v) => v.publishingJobs.some((j) => ["uploading", "published"].includes(j.status)))) throw new ConflictException("A published project can't be deleted");
    await this.prisma.videoProject.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.activity.record({ entityType: "project", entityId: id, action: "deleted", actorUserId: u.id, message: "Project deleted (soft delete; files kept)" });
    return { ok: true };
  }
}

@Module({ imports: [ProductionModule], controllers: [ReviewController] })
export class ReviewModule {}
