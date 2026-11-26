import { BadRequestException, Controller, Delete, Get, Module, NotFoundException, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { EventsService } from "../events/events.service.ts";
import { MediaAssetsService, mediaUrl } from "../storage/storage.module.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import { sniffUpload, uploadOptions } from "../common/upload.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { MODELS, renderPrompt } from "../prompts/adapters.ts";
import { cleanIdentity } from "../prompts/assemble.ts";
import { PromptsModule } from "../prompts/prompts.module.ts";
import { PromptsService } from "../prompts/prompts.service.ts";
import { ProductionModule } from "../production/production.module.ts";
import { ProductionService } from "../production/production.service.ts";

const CLIP_MAX_MB = 300;
const VEO = "veo-flow";

/**
 * Flow-assisted production (owner's choice, 2026-11-26): Google Flow / Veo makes the animated clips (it has no public
 * API, so the owner pastes the prompt and downloads the clip); ReelForge does everything else: story, characters,
 * per-scene Veo prompts, then assembles the uploaded clips (with their own Veo audio), music, subtitles, review, publish.
 */
@Controller("flow")
class FlowController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly production: ProductionService,
    private readonly assets: MediaAssetsService,
    private readonly registry: ProviderRegistry,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
  ) {}

  /** Everything needed in Flow for one story: character prompts + images, and one Veo prompt per scene. */
  @Get("story/:id")
  async pack(@Param("id", ParseUUIDPipe) id: string) {
    const story = await this.prisma.story.findFirst({
      where: { id, deletedAt: null },
      include: { scripts: { where: { isCurrent: true }, include: { scenes: { orderBy: { index: "asc" }, include: { clipAsset: true, characters: { select: { characterId: true } } } } } } },
    });
    if (!story) throw new NotFoundException("Story not found");
    const scenes = story.scripts[0]?.scenes ?? [];
    const castIds = [...new Set(scenes.flatMap((s) => s.characters.map((c) => c.characterId)))];
    const characters = await this.prisma.character.findMany({ where: { id: { in: castIds } }, include: { referenceImages: { where: { isPrimary: true }, include: { mediaAsset: true } } } });
    const out = [];
    for (const s of scenes) {
      const plan = await this.prompts.forProduction(s.id);
      const veo = plan ? renderPrompt(plan.spec, VEO) : null;
      const meta = (s.clipAsset?.meta ?? {}) as { duration?: number; hasAudio?: boolean };
      out.push({
        id: s.id, index: s.index, title: s.title, description: s.description, durationHint: s.durationHint,
        dialogue: s.dialogue, characterIds: s.characters.map((c) => c.characterId),
        veoPrompt: veo?.positive ?? null, notes: veo?.dropped ?? ["No structured prompt yet: generate the scene prompts first (Prompt Studio)."],
        clip: s.clipAsset ? { url: mediaUrl(s.clipAsset.storageKey), duration: meta.duration ?? s.clipAsset.durationSec, hasAudio: meta.hasAudio ?? null, uploadedAt: s.clipAsset.createdAt } : null,
      });
    }
    return {
      story: { id: story.id, title: story.title, language: story.language, style: story.style },
      model: MODELS[VEO],
      characters: characters.map((c) => {
        const identity = cleanIdentity(c.identityPrompt || c.basePrompt);
        return {
          id: c.id, name: c.name, identity, imageUrl: mediaUrl(c.referenceImages[0]?.mediaAsset.storageKey),
          // for making the character's master image in Flow (Imagen) to use as an "ingredient" in every clip
          flowPrompt: `Pixar-style 3D animated character design of ${c.name}: ${identity}. Full body, front view, standing, friendly expression, plain soft light background, soft studio lighting, highly detailed, vertical 9:16. Exactly one character, no text.`,
        };
      }),
      scenes: out,
      clipsUploaded: out.filter((s) => s.clip).length,
    };
  }

  /** The clip made in Flow for one scene (MP4/MOV/WebM). Checked (video stream, duration, audio) before it is kept. */
  @Post("scene/:id/clip")
  @Roles("owner", "editor")
  @UseInterceptors(FileInterceptor("file", uploadOptions(CLIP_MAX_MB)))
  async upload(@Param("id", ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: SessionUser) {
    const scene = await this.prisma.storyScene.findUnique({ where: { id }, include: { script: { select: { storyId: true } } } });
    if (!scene) throw new NotFoundException("Scene not found");
    const f = sniffUpload(file, "video", CLIP_MAX_MB);
    const key = `stories/${scene.script.storyId}/flow/scene_${String(scene.index).padStart(2, "0")}_${Date.now()}.${f.ext}`;
    const asset = await this.assets.saveFromFile({ kind: "scene_clip", key, filePath: f.path, mime: f.mime });
    let info: Awaited<ReturnType<ProviderRegistry["composer"]["clipAssets"]>>;
    try {
      info = await this.registry.composer.clipAssets(key, key.replace(/\.\w+$/, ""));
    } catch (e) {
      throw new BadRequestException(`This file can't be used as a scene clip: ${e instanceof Error ? e.message : e}`);
    }
    await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { durationSec: info.duration, meta: { duration: info.duration, hasAudio: info.has_audio, frameKey: info.frame_key, audioKey: info.audio_key, source: "google-flow" } } });
    await this.prisma.storyScene.update({ where: { id }, data: { clipAssetId: asset.id } });
    this.events.emit("story", { id: scene.script.storyId, prompts: true });
    await this.activity.record({ entityType: "story", entityId: scene.script.storyId, action: "flow_clip_uploaded", actorUserId: u.id, message: `Flow clip for scene ${scene.index + 1}: ${info.duration.toFixed(1)} s${info.has_audio ? ", with sound" : ", NO sound"}` });
    return { ok: true, duration: info.duration, hasAudio: info.has_audio, url: mediaUrl(key) };
  }

  @Delete("scene/:id/clip")
  @Roles("owner", "editor")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    const scene = await this.prisma.storyScene.update({ where: { id }, data: { clipAssetId: null }, include: { script: { select: { storyId: true } } } });
    this.events.emit("story", { id: scene.script.storyId, prompts: true });
    return { ok: true };
  }

  /** Assembles the reel: scenes with a Flow clip use it (and its own audio); scenes without one use the local pipeline. */
  @Post("story/:id/assemble")
  @Roles("owner", "editor")
  async assemble(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    const story = await this.prisma.story.findFirst({ where: { id, deletedAt: null }, include: { scripts: { where: { isCurrent: true }, include: { scenes: { select: { clipAssetId: true } } } }, projects: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 } } });
    if (!story) throw new NotFoundException("Story not found");
    const scenes = story.scripts[0]?.scenes ?? [];
    const withClip = scenes.filter((s) => s.clipAssetId).length;
    if (!withClip) throw new BadRequestException("Upload at least one Flow clip first");
    const project = story.projects[0];
    if (project && ["queued", "generating", "publishing"].includes(project.status)) throw new BadRequestException(`This story's reel is "${project.status}"`);
    const projectId = project ? (await this.production.rerender(project.id), project.id) : await this.production.start(id);
    await this.activity.record({ entityType: "project", entityId: projectId, action: "flow_assemble", actorUserId: u.id, message: `Assembling the reel from ${withClip} Flow clip(s)${withClip < scenes.length ? ` + ${scenes.length - withClip} local scene(s)` : ""}` });
    return { projectId, flowClips: withClip, localScenes: scenes.length - withClip };
  }
}

@Module({ imports: [PromptsModule, ProductionModule], controllers: [FlowController] })
export class FlowModule {}
