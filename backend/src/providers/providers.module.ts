import { BadRequestException, Body, Controller, Get, Global, Injectable, Module, Put } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import type { AppEnv } from "../config/env.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import { zod } from "../common/zod.pipe.ts";
import { CurrentUser, Roles, type SessionUser } from "../auth/decorators.ts";
import { ServiceClient } from "./service-client.ts";
import { OllamaTextProvider } from "./ollama.provider.ts";
import { AgentReachReferenceProvider, ComfyImageProvider, MediaComposer, MediaVideoProvider, MediaVoiceProvider, WhisperTranscriptionProvider } from "./service.providers.ts";
import type { Capability, CapabilityMap, ProviderInfo } from "./types.ts";

type Selection = Record<Capability, string>;
const DEFAULT_SELECTION: Selection = { text: "ollama", image: "comfyui", video: "kenburns", voice: "local-tts", transcription: "faster-whisper", reference: "reference-service" };
const SETTING_KEY = "providers";

/**
 * Integration registry: every adapter is registered here and selected per capability.
 * The pipeline calls registry.get("image") etc. and never imports a concrete provider.
 * Adding a provider = implement its interface + register it below. Paid adapters require
 * an explicit confirmation flag to select, and the switch is written to the activity log.
 */
@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<Capability, Map<string, CapabilityMap[Capability]>>();
  private selection: Selection | null = null;
  /** FFmpeg editing/rendering in the media service (deterministic tooling, not a swappable AI provider). */
  readonly composer: MediaComposer;

  constructor(config: ConfigService<AppEnv, true>, private readonly prisma: PrismaService, private readonly activity: ActivityService) {
    const token = config.get("SERVICE_TOKEN", { infer: true });
    const media = new ServiceClient("media-service", config.get("MEDIA_SERVICE_URL", { infer: true }), token);
    const reference = new ServiceClient("reference-service", config.get("REFERENCE_SERVICE_URL", { infer: true }), token);
    this.composer = new MediaComposer(media);
    this.register("text", new OllamaTextProvider(config.get("OLLAMA_URL", { infer: true }), config.get("OLLAMA_TEXT_MODEL", { infer: true }), config.get("OLLAMA_VISION_MODEL", { infer: true })));
    this.register("image", new ComfyImageProvider(media));
    this.register("video", new MediaVideoProvider(media, "kenburns"));
    this.register("video", new MediaVideoProvider(media, "animatediff"));
    this.register("video", new MediaVideoProvider(media, "comfyui"));
    this.register("voice", new MediaVoiceProvider(media));
    this.register("transcription", new WhisperTranscriptionProvider(media));
    this.register("reference", new AgentReachReferenceProvider(reference));
  }

  private register<C extends Capability>(cap: C, p: CapabilityMap[C]) {
    if (!this.providers.has(cap)) this.providers.set(cap, new Map());
    this.providers.get(cap)!.set(p.info.id, p);
  }

  private async currentSelection(): Promise<Selection> {
    if (!this.selection) {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
      this.selection = { ...DEFAULT_SELECTION, ...((row?.value as Partial<Selection>) ?? {}) };
    }
    return this.selection;
  }

  async get<C extends Capability>(cap: C): Promise<CapabilityMap[C]> {
    const id = (await this.currentSelection())[cap];
    const p = this.providers.get(cap)?.get(id);
    if (!p) throw new Error(`No ${cap} provider "${id}" is registered`);
    return p as CapabilityMap[C];
  }

  /** A specific registered provider regardless of the selection (e.g. Ken Burns for scenes without an AI clip). */
  registered<C extends Capability>(cap: C, id: string): CapabilityMap[C] {
    const p = this.providers.get(cap)?.get(id);
    if (!p) throw new Error(`No ${cap} provider "${id}" is registered`);
    return p as CapabilityMap[C];
  }

  async describe() {
    const sel = await this.currentSelection();
    const out: { capability: Capability; selected: string; options: (ProviderInfo & { health: { ok: boolean; detail: string } })[] }[] = [];
    for (const [cap, map] of this.providers) {
      const options = await Promise.all([...map.values()].map(async (p) => ({ ...p.info, health: await p.health() })));
      out.push({ capability: cap, selected: sel[cap], options });
    }
    return out;
  }

  async select(cap: Capability, id: string, confirmPaid: boolean, userId: string) {
    const p = this.providers.get(cap)?.get(id);
    if (!p) throw new BadRequestException(`Unknown ${cap} provider "${id}"`);
    if (p.info.paid && !confirmPaid) throw new BadRequestException(`"${p.info.label}" is a paid service. Confirm explicitly to enable it.`);
    const sel = { ...(await this.currentSelection()), [cap]: id };
    await this.prisma.systemSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: sel, updatedBy: userId }, update: { value: sel, updatedBy: userId } });
    this.selection = sel;
    await this.activity.record({ entityType: "settings", action: "provider_selected", message: `${cap} provider set to ${p.info.label}${p.info.paid ? " (PAID)" : ""}`, actorUserId: userId, level: p.info.paid ? "warn" : "info" });
  }
}

const SelectBody = z.object({
  capability: z.enum(["text", "image", "video", "voice", "transcription", "reference"]),
  providerId: z.string().min(1),
  confirmPaid: z.boolean().default(false),
});

@Controller("integrations")
class IntegrationsController {
  constructor(private readonly registry: ProviderRegistry) {}

  @Get()
  list() {
    return this.registry.describe();
  }

  @Put()
  @Roles("owner")
  async select(@Body(zod(SelectBody)) b: z.infer<typeof SelectBody>, @CurrentUser() user: SessionUser) {
    await this.registry.select(b.capability, b.providerId, b.confirmPaid, user.id);
    return { ok: true };
  }
}

@Global()
@Module({ controllers: [IntegrationsController], providers: [ProviderRegistry], exports: [ProviderRegistry] })
export class ProvidersModule {}
