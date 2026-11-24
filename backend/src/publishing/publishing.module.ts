import crypto from "node:crypto";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, type OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import type { Job } from "bullmq";
import type { Auth } from "googleapis";
import { z } from "zod";
import type { AppEnv } from "../config/env.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { QueuesService } from "../queues/queues.module.ts";
import { STORAGE, type StorageAdapter } from "../storage/storage.types.ts";
import { mediaUrl } from "../storage/storage.module.ts";
import { SettingsModule, SettingsService } from "../settings/settings.module.ts";
import { decryptJson, encryptJson } from "../common/crypto.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { YouTubeClient } from "./youtube.client.ts";
import { InstagramClient, type IgCredentials } from "./instagram.client.ts";
import { checkGate } from "./gate.ts";
import { Prisma, type Platform } from "../generated/prisma/client.ts";

class GateError extends Error {}

@Injectable()
export class PublishingService implements OnApplicationBootstrap {
  private readonly log = new Logger("Publishing");
  readonly youtube: YouTubeClient;
  readonly instagram: InstagramClient;
  private readonly key: string;
  private readonly states = new Map<string, { platform: Platform; exp: number }>();

  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly queues: QueuesService,
    private readonly settings: SettingsService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {
    const base = config.get("PUBLIC_BASE_URL", { infer: true }).replace(/\/$/, "");
    this.key = config.get("TOKEN_ENCRYPTION_KEY", { infer: true });
    this.youtube = new YouTubeClient(config.get("GOOGLE_CLIENT_ID", { infer: true }), config.get("GOOGLE_CLIENT_SECRET", { infer: true }), `${base}/api/oauth/youtube/callback`);
    this.instagram = new InstagramClient(config.get("META_APP_ID", { infer: true }), config.get("META_APP_SECRET", { infer: true }), config.get("IG_GRAPH_VERSION", { infer: true }), `${base}/api/oauth/instagram/callback`);
  }

  onApplicationBootstrap() {
    this.queues.process("publishing", (job) => this.publish(job), async (job, err) => {
      const id = (job.data as { publishingJobId: string }).publishingJobId;
      await this.prisma.publishingJob.updateMany({ where: { id, status: { in: ["queued", "scheduled", "uploading"] } }, data: { status: "failed", lastError: { message: err.message, at: new Date().toISOString() } } });
      this.events.emit("publishing", { id, status: "failed" });
    });
    // analytics every 6 hours (no-op until something is published)
    void this.queues.queue("maintenance").upsertJobScheduler("analytics", { pattern: "0 */6 * * *" }, { name: "analytics", data: {}, opts: { attempts: 1 } })
      .catch((e: unknown) => this.log.warn(`analytics scheduler: ${String(e)}`));
  }

  /* ------------------------------ accounts ------------------------------ */

  newState(platform: Platform) {
    const s = crypto.randomBytes(16).toString("hex");
    this.states.set(s, { platform, exp: Date.now() + 10 * 60_000 });
    return s;
  }
  consumeState(s: string | undefined, platform: Platform) {
    const v = s ? this.states.get(s) : undefined;
    if (s) this.states.delete(s);
    return Boolean(v && v.platform === platform && v.exp > Date.now());
  }

  async saveAccount(platform: Platform, accountId: string, accountName: string, credentials: unknown, scopes: string[], expiresAt: Date | null, userId: string) {
    const data = { accountId, accountName, encryptedTokens: encryptJson(this.key, credentials), scopes, status: "connected" as const, expiresAt };
    await this.prisma.publishingAccount.upsert({ where: { platform }, create: { platform, ...data }, update: data });
    await this.activity.record({ entityType: "account", action: `${platform}_connected`, actorUserId: userId, message: `${platform} connected: ${accountName}` });
  }

  private async credentials<T>(platform: Platform) {
    const a = await this.prisma.publishingAccount.findUnique({ where: { platform } });
    if (!a || a.status !== "connected") return null;
    if (a.expiresAt && a.expiresAt < new Date()) {
      await this.prisma.publishingAccount.update({ where: { platform }, data: { status: "expired" } });
      return null;
    }
    return { account: a, creds: decryptJson<T>(this.key, a.encryptedTokens) };
  }

  private ytApi(account: { platform: Platform }, creds: Auth.Credentials) {
    return this.youtube.api(creds, (t) => {
      void this.prisma.publishingAccount.update({ where: { platform: account.platform }, data: { encryptedTokens: encryptJson(this.key, t) } });
    });
  }

  /* ------------------------------ the gate ------------------------------ */

  /**
   * Independent approval check, run by the worker immediately before uploading, inside a transaction that
   * also claims the job (queued/scheduled → uploading). Frontend state is never trusted.
   */
  private async claim(jobId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PublishingJob" WHERE id = ${jobId}::uuid FOR UPDATE`;
      if (!rows.length) throw new GateError("Publishing job no longer exists");
      const job = await tx.publishingJob.findUniqueOrThrow({ where: { id: jobId }, include: { published: true, version: { include: { project: true } } } });
      const decisions = await tx.approval.findMany({ where: { versionId: job.versionId }, select: { id: true, decision: true, platforms: true, decidedAt: true } });
      const gate = checkGate({
        job: { status: job.status, platform: job.platform, approvalId: job.approvalId, alreadyPublished: Boolean(job.published) },
        version: { status: job.version.status },
        projectDeleted: Boolean(job.version.project.deletedAt),
        decisions,
      });
      if (!gate.ok && gate.skip) return { job, already: true as const };
      if (!gate.ok) throw new GateError(gate.reason);
      await tx.publishingJob.update({ where: { id: jobId }, data: { status: "uploading", attempts: { increment: 1 } } });
      return { job, already: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async publish(bull: Job) {
    const { publishingJobId: id } = bull.data as { publishingJobId: string };
    let claimed;
    try {
      claimed = await this.claim(id);
    } catch (e) {
      if (e instanceof GateError) {
        await this.prisma.publishingJob.updateMany({ where: { id, status: { notIn: ["published", "uploading"] } }, data: { status: "cancelled", lastError: { gate: e.message } } });
        await this.activity.record({ entityType: "publishing", entityId: id, action: "blocked", level: "error", message: `Publishing blocked by approval check: ${e.message}` });
        this.events.emit("publishing", { id, status: "cancelled" });
        return; // never retried
      }
      throw e;
    }
    if (claimed.already) return;
    const { job } = claimed;
    this.events.emit("publishing", { id, status: "uploading" });

    const version = await this.prisma.videoVersion.findUniqueOrThrow({ where: { id: job.versionId }, include: { videoAsset: true, script: true } });
    if (!version.videoAsset) throw new Error("Version has no video asset");
    const s = version.script;

    let result: { remoteId: string; url: string | null };
    try {
      if (job.platform === "youtube") {
        const c = await this.credentials<Auth.Credentials>("youtube");
        if (!c) return this.manualRequired(id, "YouTube is not connected. In Settings → Social accounts, connect YouTube (needs GOOGLE_CLIENT_ID/SECRET from a Google Cloud OAuth client with YouTube Data API v3 enabled), or publish manually.");
        const privacy = (await this.settings.generation()).youtubePrivacy;
        result = await this.youtube.upload(this.ytApi(c.account, c.creds), { body: await this.storage.stream(version.videoAsset.storageKey), title: s.youtubeTitle, description: `${s.youtubeDescription}\n\n${s.hashtags.join(" ")}`, tags: s.hashtags, privacy });
      } else {
        const c = await this.credentials<IgCredentials>("instagram");
        if (!c) return this.manualRequired(id, "Instagram is not connected. It needs an Instagram Professional (Business/Creator) account linked to a Facebook Page and a Meta app with instagram_content_publish; connect it in Settings → Social accounts, or publish manually.");
        result = await this.instagram.publishReel(c.creds, await this.storage.read(version.videoAsset.storageKey), `${s.instagramCaption}\n\n${s.hashtags.join(" ")}`);
      }
    } catch (e) {
      await this.prisma.publishingJob.update({ where: { id }, data: { status: "queued", lastError: { message: e instanceof Error ? e.message : String(e), at: new Date().toISOString() } } });
      throw e; // BullMQ retries; the gate runs again on the next attempt
    }
    await this.recordPublished(id, job.platform, result.remoteId, result.url);
  }

  private async manualRequired(id: string, reason: string) {
    await this.prisma.publishingJob.update({ where: { id }, data: { status: "manual_required", lastError: { reason } } });
    await this.activity.record({ entityType: "publishing", entityId: id, action: "manual_required", level: "warn", message: reason });
    this.events.emit("publishing", { id, status: "manual_required" });
  }

  async recordPublished(id: string, platform: Platform, remoteId: string, url: string | null) {
    const job = await this.prisma.$transaction(async (tx) => {
      await tx.publishedVideo.create({ data: { publishingJobId: id, platform, remoteId, url, publishedAt: new Date() } });
      const j = await tx.publishingJob.update({ where: { id }, data: { status: "published", lastError: Prisma.DbNull } });
      const pending = await tx.publishingJob.count({ where: { versionId: j.versionId, status: { in: ["queued", "scheduled", "uploading", "manual_required"] } } });
      if (!pending) {
        const v = await tx.videoVersion.findUniqueOrThrow({ where: { id: j.versionId } });
        await tx.videoProject.update({ where: { id: v.projectId }, data: { status: "published" } });
      }
      return j;
    });
    this.events.emit("publishing", { id, status: "published", url });
    await this.activity.record({ entityType: "publishing", entityId: id, action: "published", message: `Published to ${platform}: ${url ?? remoteId}`, data: { remoteId, url, versionId: job.versionId } });
  }

  /** Manual publishing fallback: only after the same approval gate passes. */
  async markManual(id: string, url: string, remoteId: string | null, userId: string) {
    const claimed = await this.claim(id).catch((e: unknown) => { throw new ConflictException(e instanceof Error ? e.message : String(e)); });
    if (claimed.already) throw new ConflictException("Already published");
    await this.recordPublished(id, claimed.job.platform, remoteId ?? url, url);
    await this.activity.record({ entityType: "publishing", entityId: id, action: "manual_published", actorUserId: userId, message: `Marked as manually published: ${url}` });
  }

  async retry(id: string, userId: string) {
    const j = await this.prisma.publishingJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException("Publishing job not found");
    if (!["failed", "manual_required"].includes(j.status)) throw new ConflictException(`Job is "${j.status}"`);
    await this.prisma.publishingJob.update({ where: { id }, data: { status: "queued" } });
    const bullJobId = await this.queues.enqueue("publishing", "publish", { publishingJobId: id }, { attempts: 3, backoff: { type: "exponential", delay: 120_000 }, jobId: `publish-${id}-${Date.now()}` });
    await this.prisma.publishingJob.update({ where: { id }, data: { bullJobId } });
    await this.activity.record({ entityType: "publishing", entityId: id, action: "retry", actorUserId: userId, message: `Retry requested for ${j.platform}` });
  }

  /* ------------------------------ analytics ------------------------------ */

  async refreshAnalytics() {
    const vids = await this.prisma.publishedVideo.findMany({ where: { publishedAt: { gte: new Date(Date.now() - 90 * 86400_000) } } });
    let n = 0;
    const yt = vids.filter((v) => v.platform === "youtube");
    const ytc = yt.length ? await this.credentials<Auth.Credentials>("youtube") : null;
    if (ytc) {
      const stats = await this.youtube.stats(this.ytApi(ytc.account, ytc.creds), yt.map((v) => v.remoteId));
      for (const v of yt) {
        const s = stats.get(v.remoteId);
        if (s) { await this.prisma.videoAnalytics.create({ data: { publishedVideoId: v.id, views: s.views, likes: s.likes, comments: s.comments, raw: s.raw as Prisma.InputJsonValue } }); n++; }
      }
    }
    const igc = vids.some((v) => v.platform === "instagram") ? await this.credentials<IgCredentials>("instagram") : null;
    if (igc) {
      for (const v of vids.filter((x) => x.platform === "instagram")) {
        try {
          const s = await this.instagram.insights(igc.creds, v.remoteId);
          await this.prisma.videoAnalytics.create({ data: { publishedVideoId: v.id, views: s.views, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves, reach: s.reach, raw: s.raw as Prisma.InputJsonValue } });
          n++;
        } catch (e) {
          await this.activity.record({ entityType: "publishing", entityId: v.id, action: "analytics_failed", level: "warn", message: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    if (vids.length) await this.activity.record({ entityType: "system", action: "analytics_refreshed", message: `Analytics refreshed for ${n} of ${vids.length} published video(s)` });
    return n;
  }
}

const ManualBody = z.object({ url: z.string().url(), remoteId: z.string().max(200).optional() });
const IgTokenBody = z.object({ accessToken: z.string().min(20).max(2000), igUserId: z.string().regex(/^\d+$/).optional() });

@Controller()
class PublishingController {
  constructor(private readonly svc: PublishingService, private readonly prisma: PrismaService, private readonly activity: ActivityService, private readonly config: ConfigService<AppEnv, true>) {}

  @Get("publishing")
  async list() {
    const jobs = await this.prisma.publishingJob.findMany({
      orderBy: { createdAt: "desc" }, take: 300,
      include: { published: { include: { analytics: { orderBy: { capturedAt: "desc" }, take: 1 } } }, version: { include: { thumbnailAsset: { select: { storageKey: true } }, project: { include: { story: { select: { title: true, category: true } } } } } }, approval: { include: { user: { select: { displayName: true } } } } },
    });
    return jobs.map(({ version, ...j }) => ({ ...j, storyTitle: version.project.story.title, category: version.project.story.category, versionNo: version.versionNo, projectId: version.projectId, thumbnailUrl: mediaUrl(version.thumbnailAsset?.storageKey) }));
  }

  /** Account status only — tokens are never returned. */
  @Get("publishing/accounts")
  async accounts() {
    const rows = await this.prisma.publishingAccount.findMany({ select: { platform: true, accountName: true, status: true, expiresAt: true, updatedAt: true } });
    return {
      youtube: { oauthConfigured: this.svc.youtube.configured, account: rows.find((r) => r.platform === "youtube") ?? null },
      instagram: { oauthConfigured: this.svc.instagram.oauthConfigured, account: rows.find((r) => r.platform === "instagram") ?? null },
    };
  }

  @Get("oauth/youtube/start")
  @Roles("owner")
  ytStart(@Res() res: Response) {
    if (!this.svc.youtube.configured) throw new BadRequestException("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env first (Google Cloud → OAuth client, YouTube Data API v3 enabled)");
    res.redirect(this.svc.youtube.authUrl(this.svc.newState("youtube")));
  }

  @Get("oauth/youtube/callback")
  @Roles("owner")
  async ytCallback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error") error: string | undefined, @CurrentUser() u: SessionUser, @Res() res: Response) {
    const back = (err?: string) => res.redirect(`${this.config.get("FRONTEND_URL", { infer: true })}/settings?tab=social&connected=youtube${err ? `&error=${encodeURIComponent(err)}` : ""}`);
    if (!this.svc.consumeState(state, "youtube")) return back("Invalid or expired OAuth state");
    if (error || !code) return back(error ?? "No authorization code");
    try {
      const r = await this.svc.youtube.exchange(code);
      await this.svc.saveAccount("youtube", r.channelId, r.channelTitle, r.tokens, ["youtube.upload", "youtube.readonly"], null, u.id);
      back();
    } catch (e) { back(e instanceof Error ? e.message : String(e)); }
  }

  @Get("oauth/instagram/start")
  @Roles("owner")
  igStart(@Res() res: Response) {
    if (!this.svc.instagram.oauthConfigured) throw new BadRequestException("Set META_APP_ID and META_APP_SECRET in backend/.env, or connect with an access token instead");
    res.redirect(this.svc.instagram.authUrl(this.svc.newState("instagram")));
  }

  @Get("oauth/instagram/callback")
  @Roles("owner")
  async igCallback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error_description") error: string | undefined, @CurrentUser() u: SessionUser, @Res() res: Response) {
    const back = (err?: string) => res.redirect(`${this.config.get("FRONTEND_URL", { infer: true })}/settings?tab=social&connected=instagram${err ? `&error=${encodeURIComponent(err)}` : ""}`);
    if (!this.svc.consumeState(state, "instagram")) return back("Invalid or expired OAuth state");
    if (error || !code) return back(error ?? "No authorization code");
    try {
      const r = await this.svc.instagram.exchangeCode(code);
      await this.svc.saveAccount("instagram", r.credentials.igUserId, r.username, r.credentials, ["instagram_content_publish"], r.expiresAt, u.id);
      back();
    } catch (e) { back(e instanceof Error ? e.message : String(e)); }
  }

  @Post("publishing/accounts/instagram/token")
  @Roles("owner")
  async igToken(@Body(zod(IgTokenBody)) b: z.infer<typeof IgTokenBody>, @CurrentUser() u: SessionUser) {
    const r = await this.svc.instagram.connect(b.accessToken.trim(), b.igUserId);
    await this.svc.saveAccount("instagram", r.credentials.igUserId, r.username, r.credentials, ["instagram_content_publish"], r.expiresAt, u.id);
    return { ok: true, username: r.username };
  }

  @Delete("publishing/accounts/:platform")
  @Roles("owner")
  async disconnect(@Param("platform") platform: string, @CurrentUser() u: SessionUser) {
    const p = z.enum(["youtube", "instagram"]).parse(platform);
    await this.prisma.publishingAccount.deleteMany({ where: { platform: p } });
    await this.activity.record({ entityType: "account", action: `${p}_disconnected`, actorUserId: u.id, message: `${p} disconnected` });
    return { ok: true };
  }

  @Post("publishing/:id/retry")
  @Roles("owner")
  async retry(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.svc.retry(id, u.id);
    return { ok: true };
  }

  @Post("publishing/:id/manual")
  @Roles("owner")
  async manual(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ManualBody)) b: z.infer<typeof ManualBody>, @CurrentUser() u: SessionUser) {
    await this.svc.markManual(id, b.url, b.remoteId ?? null, u.id);
    return { ok: true };
  }

  @Post("analytics/refresh")
  @Roles("owner")
  async refresh() {
    return { updated: await this.svc.refreshAnalytics() };
  }

  @Get("analytics")
  async analytics() {
    const vids = await this.prisma.publishedVideo.findMany({
      orderBy: { publishedAt: "desc" },
      include: { analytics: { orderBy: { capturedAt: "asc" } }, publishingJob: { include: { version: { include: { project: { include: { story: { select: { title: true, category: true } } } } } } } } },
    });
    const rows = vids.map((v) => {
      const last = v.analytics.at(-1);
      return { id: v.id, platform: v.platform, url: v.url, publishedAt: v.publishedAt, title: v.publishingJob.version.project.story.title, category: v.publishingJob.version.project.story.category,
        views: last?.views ?? null, likes: last?.likes ?? null, comments: last?.comments ?? null, shares: last?.shares ?? null, saves: last?.saves ?? null, history: v.analytics.map((a) => ({ at: a.capturedAt, views: a.views })) };
    });
    const sum = (p: string, k: "views" | "likes" | "comments") => rows.filter((r) => r.platform === p).reduce((t, r) => t + (r[k] ?? 0), 0);
    return {
      totals: { published: rows.length, youtube: { videos: rows.filter((r) => r.platform === "youtube").length, views: sum("youtube", "views"), likes: sum("youtube", "likes"), comments: sum("youtube", "comments") }, instagram: { videos: rows.filter((r) => r.platform === "instagram").length, views: sum("instagram", "views"), likes: sum("instagram", "likes"), comments: sum("instagram", "comments") } },
      top: [...rows].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 10),
      rows,
    };
  }
}

@Module({ imports: [SettingsModule], controllers: [PublishingController], providers: [PublishingService], exports: [PublishingService] })
export class PublishingModule {}
