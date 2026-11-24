import { Body, Controller, Delete, Get, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { MediaAssetsService, mediaUrl } from "../storage/storage.module.ts";
import { ProviderRegistry } from "../providers/providers.module.ts";
import { zod } from "../common/zod.pipe.ts";
import { sniffUpload, uploadOptions } from "../common/upload.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";

const IMAGE_MAX_MB = 20;

const CharacterBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  appearance: z.string().trim().min(1).max(2000),
  furColors: z.string().trim().max(500).default(""),
  clothingColors: z.string().trim().max(500).default(""),
  personality: z.string().trim().max(1000).default(""),
  basePrompt: z.string().trim().min(10).max(2000),
  negativePrompt: z.string().trim().max(1000).default(""),
  expressionPresets: z.record(z.string(), z.string()).default({}),
  isStoryteller: z.boolean().default(false),
  voiceProfileId: z.string().uuid().nullable().default(null),
  active: z.boolean().default(true),
});

const VoiceBody = z.object({
  name: z.string().trim().min(1).max(60),
  engine: z.enum(["kokoro", "piper"]),
  voiceId: z.string().trim().min(1).max(120),
  language: z.enum(["en", "hi", "hinglish"]),
  speed: z.number().min(0.5).max(2).default(1),
  style: z.string().trim().max(300).default(""),
  isNarrator: z.boolean().default(false),
});

const characterInclude = {
  voiceProfile: true,
  referenceImages: { include: { mediaAsset: { select: { storageKey: true, width: true, height: true } } }, orderBy: { createdAt: "desc" as const } },
  _count: { select: { scenes: true } },
};

type CharacterWithRelations = Awaited<ReturnType<PrismaService["character"]["findFirstOrThrow"]>> & {
  referenceImages: { id: string; kind: string; isPrimary: boolean; createdAt: Date; mediaAsset: { storageKey: string } }[];
  voiceProfile: unknown;
  _count: { scenes: number };
};

function present(c: CharacterWithRelations) {
  const { referenceImages, _count, ...rest } = c;
  const images = referenceImages.map((r) => ({ id: r.id, kind: r.kind, isPrimary: r.isPrimary, url: mediaUrl(r.mediaAsset.storageKey), createdAt: r.createdAt }));
  return { ...rest, images, primaryImageUrl: images.find((i) => i.isPrimary)?.url ?? images[0]?.url ?? null, sceneCount: _count.scenes };
}

@Controller("characters")
class CharactersController {
  constructor(private readonly prisma: PrismaService, private readonly activity: ActivityService, private readonly assets: MediaAssetsService) {}

  @Get()
  async list() {
    const rows = await this.prisma.character.findMany({ where: { deletedAt: null }, include: characterInclude, orderBy: [{ isStoryteller: "desc" }, { createdAt: "asc" }] });
    return rows.map((r) => present(r as CharacterWithRelations));
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const c = await this.prisma.character.findFirst({ where: { id, deletedAt: null }, include: characterInclude });
    if (!c) throw new NotFoundException("Character not found");
    return present(c as CharacterWithRelations);
  }

  @Post()
  @Roles("owner", "editor")
  async create(@Body(zod(CharacterBody)) b: z.infer<typeof CharacterBody>, @CurrentUser() u: SessionUser) {
    const c = await this.prisma.character.create({ data: { ...b, seed: Math.floor(Math.random() * 2_000_000_000) } });
    await this.activity.record({ entityType: "character", entityId: c.id, action: "created", message: `Character ${c.name} created`, actorUserId: u.id });
    return { id: c.id };
  }

  @Put(":id")
  @Roles("owner", "editor")
  async update(@Param("id", ParseUUIDPipe) id: string, @Body(zod(CharacterBody)) b: z.infer<typeof CharacterBody>, @CurrentUser() u: SessionUser) {
    await this.prisma.character.update({ where: { id, deletedAt: null }, data: b });
    await this.activity.record({ entityType: "character", entityId: id, action: "updated", message: `Character ${b.name} updated`, actorUserId: u.id });
    return { ok: true };
  }

  @Delete(":id")
  @Roles("owner")
  async remove(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    const c = await this.prisma.character.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    await this.activity.record({ entityType: "character", entityId: id, action: "deleted", message: `Character ${c.name} removed (soft delete)`, actorUserId: u.id });
    return { ok: true };
  }

  @Post(":id/images")
  @Roles("owner", "editor")
  @UseInterceptors(FileInterceptor("file", uploadOptions(IMAGE_MAX_MB)))
  async uploadImage(@Param("id", ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: SessionUser) {
    const c = await this.prisma.character.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new NotFoundException("Character not found");
    const f = sniffUpload(file, "image", IMAGE_MAX_MB);
    const asset = await this.assets.saveFromFile({ kind: "character_image", key: `characters/${id}/uploaded_${Date.now()}.${f.ext}`, filePath: f.path, mime: f.mime });
    const hasPrimary = await this.prisma.characterReferenceImage.count({ where: { characterId: id, isPrimary: true } });
    const img = await this.prisma.characterReferenceImage.create({ data: { characterId: id, mediaAssetId: asset.id, kind: "uploaded", isPrimary: hasPrimary === 0 } });
    await this.activity.record({ entityType: "character", entityId: id, action: "image_uploaded", message: `Reference image added to ${c.name}`, actorUserId: u.id });
    return { id: img.id, url: mediaUrl(asset.storageKey) };
  }

  @Post(":id/images/:imageId/primary")
  @Roles("owner", "editor")
  async setPrimary(@Param("id", ParseUUIDPipe) id: string, @Param("imageId", ParseUUIDPipe) imageId: string) {
    await this.prisma.$transaction([
      this.prisma.characterReferenceImage.updateMany({ where: { characterId: id }, data: { isPrimary: false } }),
      this.prisma.characterReferenceImage.update({ where: { id: imageId, characterId: id }, data: { isPrimary: true } }),
    ]);
    return { ok: true };
  }

  @Delete(":id/images/:imageId")
  @Roles("owner", "editor")
  async removeImage(@Param("id", ParseUUIDPipe) id: string, @Param("imageId", ParseUUIDPipe) imageId: string, @CurrentUser() u: SessionUser) {
    await this.prisma.characterReferenceImage.delete({ where: { id: imageId, characterId: id } });
    await this.activity.record({ entityType: "character", entityId: id, action: "image_removed", message: "Reference image removed", actorUserId: u.id });
    return { ok: true };
  }
}

@Controller("voice-profiles")
class VoiceProfilesController {
  constructor(private readonly prisma: PrismaService, private readonly activity: ActivityService, private readonly registry: ProviderRegistry) {}

  @Get()
  list() {
    return this.prisma.voiceProfile.findMany({ orderBy: [{ isNarrator: "desc" }, { name: "asc" }], include: { characters: { where: { deletedAt: null }, select: { id: true, name: true } } } });
  }

  /** Voices actually installed in the local TTS engines (from the media service). */
  @Get("available")
  async available() {
    return (await this.registry.get("voice")).listVoices();
  }

  @Post()
  @Roles("owner", "editor")
  async create(@Body(zod(VoiceBody)) b: z.infer<typeof VoiceBody>, @CurrentUser() u: SessionUser) {
    const v = await this.prisma.voiceProfile.create({ data: b });
    await this.activity.record({ entityType: "voice", entityId: v.id, action: "created", message: `Voice profile ${v.name} created`, actorUserId: u.id });
    return { id: v.id };
  }

  @Put(":id")
  @Roles("owner", "editor")
  async update(@Param("id", ParseUUIDPipe) id: string, @Body(zod(VoiceBody)) b: z.infer<typeof VoiceBody>, @CurrentUser() u: SessionUser) {
    await this.prisma.voiceProfile.update({ where: { id }, data: b });
    await this.activity.record({ entityType: "voice", entityId: id, action: "updated", message: `Voice profile ${b.name} updated`, actorUserId: u.id });
    return { ok: true };
  }

  @Delete(":id")
  @Roles("owner")
  async remove(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser) {
    await this.prisma.voiceProfile.delete({ where: { id } });
    await this.activity.record({ entityType: "voice", entityId: id, action: "deleted", message: "Voice profile deleted", actorUserId: u.id });
    return { ok: true };
  }
}

@Module({ controllers: [CharactersController, VoiceProfilesController] })
export class CharactersModule {}
