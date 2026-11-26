import { Body, Controller, Get, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { mediaUrl } from "../storage/storage.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { KEYFRAME_MODEL, MODELS, renderPrompt } from "./adapters.ts";
import type { ScenePromptSpec } from "./spec.ts";
import { PromptsService } from "./prompts.service.ts";

const ModelId = z.string().refine((m) => m in MODELS, "unknown model");
const GenerateStoryBody = z.object({ targetModel: ModelId.optional(), onlyMissing: z.boolean().default(false) });
const GenerateSceneBody = z.object({ targetModel: ModelId.optional() });
const TransformBody = z.object({ op: z.enum(["improve", "shorten", "expand", "instruct"]), instruction: z.string().trim().max(1000).optional() })
  .refine((b) => b.op !== "instruct" || (b.instruction?.length ?? 0) >= 3, "instruction is required for op=instruct");
const EditBody = z.object({ draft: z.unknown().optional(), positive: z.string().max(6000).nullable().optional(), negative: z.string().max(4000).nullable().optional() });
const ModelBody = z.object({ targetModel: ModelId });
const TemplateBody = z.object({ promptId: z.string().uuid(), name: z.string().trim().min(2).max(80), notes: z.string().max(500).default("") });
const ApplyTemplateBody = z.object({ templateId: z.string().uuid() });

/** Prompt Studio API. LLM work is queued (production queue, one model at a time); edits are immediate. */
@Controller("prompts")
class PromptsController {
  constructor(private readonly prompts: PromptsService, private readonly prisma: PrismaService, private readonly activity: ActivityService) {}

  @Get("models")
  models() {
    return this.prompts.models();
  }

  /** Everything Prompt Studio shows for one story: bible, scenes with current prompts, character prompts, pending jobs. */
  @Get("story/:id")
  async story(@Param("id", ParseUUIDPipe) id: string) {
    const story = await this.prisma.story.findFirst({
      where: { id, deletedAt: null },
      include: {
        scripts: {
          where: { isCurrent: true },
          include: {
            scenes: {
              orderBy: { index: "asc" },
              include: {
                characters: { include: { character: { select: { id: true, name: true, referenceImages: { where: { isPrimary: true }, select: { mediaAsset: { select: { storageKey: true } } } } } } } },
                prompts: { where: { kind: "scene_video" }, orderBy: { version: "desc" }, select: { id: true, version: true, isCurrent: true, origin: true, targetModel: true, score: true, createdAt: true, instruction: true } },
              },
            },
          },
        },
      },
    });
    if (!story) throw new NotFoundException("Story not found");
    const script = story.scripts[0];
    const current = await this.prisma.generatedPrompt.findMany({ where: { kind: "scene_video", isCurrent: true, sceneId: { in: script?.scenes.map((s) => s.id) ?? [] } } });
    const castIds = [...new Set(script?.scenes.flatMap((s) => s.characters.map((c) => c.characterId)) ?? [])];
    const characters = await this.prisma.character.findMany({
      where: { id: { in: castIds } },
      include: { referenceImages: { where: { isPrimary: true }, include: { mediaAsset: { select: { storageKey: true } } } }, prompts: { where: { kind: "character_reference", isCurrent: true }, orderBy: { view: "asc" } } },
    });
    const { scripts: _s, ...storyRest } = story;
    return {
      story: storyRest,
      script: script ? { id: script.id, version: script.version, narration: script.narration } : null,
      scenes: (script?.scenes ?? []).map((s) => {
        const p = current.find((c) => c.sceneId === s.id);
        const spec = p?.spec as unknown as ScenePromptSpec | undefined;
        return {
          id: s.id, index: s.index, title: s.title, description: s.description, location: s.location, events: s.events, dialogue: s.dialogue, durationHint: s.durationHint,
          characters: s.characters.map((c) => ({ id: c.character.id, name: c.character.name, imageUrl: mediaUrl(c.character.referenceImages[0]?.mediaAsset.storageKey) })),
          prompt: p ? { ...p, keyframe: spec ? renderPrompt(spec, KEYFRAME_MODEL) : null } : null,
          history: s.prompts,
        };
      }),
      characters: characters.map((c) => ({
        id: c.id, name: c.name, species: c.species, personality: c.personality, identity: c.identityPrompt || c.basePrompt, visualProfile: c.visualProfile,
        imageUrl: mediaUrl(c.referenceImages[0]?.mediaAsset.storageKey), referencePrompts: c.prompts.map((p) => ({ id: p.id, view: p.view, positive: p.positive, negative: p.negative, version: p.version })),
      })),
      pending: await this.prompts.pendingFor(id),
    };
  }

  @Post("story/:id/generate")
  @Roles("owner", "editor")
  async generateStory(@Param("id", ParseUUIDPipe) id: string, @Body(zod(GenerateStoryBody)) b: z.infer<typeof GenerateStoryBody>, @CurrentUser() u: SessionUser) {
    const r = await this.prompts.enqueue("prompts-story", { storyId: id, targetModel: b.targetModel, onlyMissing: b.onlyMissing }, `story:${id}`);
    if (!r.duplicate) await this.activity.record({ entityType: "story", entityId: id, action: "prompts_requested", message: "Scene prompt generation queued", actorUserId: u.id });
    return r;
  }

  @Get("scene/:id/versions")
  versions(@Param("id", ParseUUIDPipe) id: string) {
    return this.prisma.generatedPrompt.findMany({ where: { sceneId: id, kind: "scene_video" }, orderBy: { version: "desc" }, take: 50 });
  }

  @Post("scene/:id/generate")
  @Roles("owner", "editor")
  async generateScene(@Param("id", ParseUUIDPipe) id: string, @Body(zod(GenerateSceneBody)) b: z.infer<typeof GenerateSceneBody>, @CurrentUser() u: SessionUser) {
    const scene = await this.sceneStory(id);
    return this.prompts.enqueue("prompt-scene", { sceneId: id, storyId: scene, targetModel: b.targetModel, userId: u.id }, `scene:${id}`);
  }

  @Post(":id/transform")
  @Roles("owner", "editor")
  async transform(@Param("id", ParseUUIDPipe) id: string, @Body(zod(TransformBody)) b: z.infer<typeof TransformBody>, @CurrentUser() u: SessionUser) {
    const p = await this.prisma.generatedPrompt.findUnique({ where: { id } });
    if (!p?.sceneId) throw new NotFoundException("Scene prompt not found");
    return this.prompts.enqueue("prompt-scene", { sceneId: p.sceneId, storyId: await this.sceneStory(p.sceneId), op: b.op, instruction: b.instruction, userId: u.id }, `scene:${p.sceneId}`);
  }

  @Put(":id")
  @Roles("owner", "editor")
  edit(@Param("id", ParseUUIDPipe) id: string, @Body(zod(EditBody)) b: z.infer<typeof EditBody>, @CurrentUser() u: SessionUser) {
    return this.prompts.edit(id, b, u.id);
  }

  @Post(":id/model")
  @Roles("owner", "editor")
  model(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ModelBody)) b: z.infer<typeof ModelBody>, @CurrentUser() u: SessionUser) {
    return this.prompts.switchModel(id, b.targetModel, u.id);
  }

  @Post(":id/restore")
  @Roles("owner", "editor")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    return this.prompts.restore(id, u.id);
  }

  @Get("templates")
  templates() {
    return this.prisma.promptTemplate.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: "desc" } });
  }

  @Post("templates")
  @Roles("owner", "editor")
  saveTemplate(@Body(zod(TemplateBody)) b: z.infer<typeof TemplateBody>) {
    return this.prompts.saveTemplate(b.promptId, b.name, b.notes);
  }

  @Post(":id/apply-template")
  @Roles("owner", "editor")
  applyTemplate(@Param("id", ParseUUIDPipe) id: string, @Body(zod(ApplyTemplateBody)) b: z.infer<typeof ApplyTemplateBody>, @CurrentUser() u: SessionUser) {
    return this.prompts.applyTemplate(id, b.templateId, u.id);
  }

  /** Writes (or rewrites with force) a character's permanent profile and reference-view prompts. */
  @Post("character/:id/profile")
  @Roles("owner", "editor")
  async characterProfile(@Param("id", ParseUUIDPipe) id: string, @Body(zod(z.object({ force: z.boolean().default(false), storyId: z.string().uuid().optional() }))) b: { force: boolean; storyId?: string }) {
    const c = await this.prisma.character.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new NotFoundException("Character not found");
    return this.prompts.enqueue("character-profile", { characterId: id, force: b.force, storyId: b.storyId }, `character:${id}`);
  }

  private async sceneStory(sceneId: string): Promise<string> {
    const s = await this.prisma.storyScene.findUnique({ where: { id: sceneId }, select: { script: { select: { storyId: true } } } });
    if (!s) throw new NotFoundException("Scene not found");
    return s.script.storyId;
  }
}

@Module({ controllers: [PromptsController], providers: [PromptsService], exports: [PromptsService] })
export class PromptsModule {}
