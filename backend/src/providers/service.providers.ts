import type {
  AnimateRequest, ExtractionResult, ImageGenerationProvider, ImageRequest, ProviderHealth, ProviderInfo,
  ReferenceExtractionProvider, TranscriptionProvider, VideoGenerationProvider, VoiceGenerationProvider, VoiceRequest, Word,
} from "./types.ts";
import type { ServiceClient } from "./service-client.ts";

/** Shape of media-service GET /health (Python, snake_case). */
export interface MediaHealth {
  ffmpeg: boolean;
  comfyui: { ok: boolean; detail: string; workflows: string[]; runnable?: string[] };
  tts: { kokoro: boolean; piper: boolean };
  whisper: { ok: boolean; model: string };
}

async function mediaHealth(client: ServiceClient): Promise<MediaHealth | { error: string }> {
  try { return await client.call<MediaHealth>("/health", undefined, 8000); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export class ComfyImageProvider implements ImageGenerationProvider {
  readonly info: ProviderInfo = { id: "comfyui", label: "ComfyUI (local, SD1.5 + IP-Adapter)", capability: "image", paid: false, local: true };
  constructor(private readonly media: ServiceClient) {}
  generate(r: ImageRequest) {
    return this.media.call<{ key: string; workflow: string }>("/image", {
      prompt: r.prompt, negative_prompt: r.negativePrompt, reference_keys: r.referenceKeys, seed: r.seed, width: r.width, height: r.height, out_key: r.outKey, ref_weight: r.referenceWeight,
    });
  }
  async health(): Promise<ProviderHealth> {
    const h = await mediaHealth(this.media);
    if ("error" in h) return { ok: false, detail: h.error };
    return { ok: h.comfyui.ok, detail: h.comfyui.detail };
  }
}

/**
 * Scene video. "kenburns" = camera motion over the still (FFmpeg, NOT AI animation); "animatediff" = real AI motion
 * (AnimateDiff v3 + LCM on SD1.5, runs on this CPU, slowly); "comfyui" = Stable Video Diffusion (needs an NVIDIA GPU).
 */
export class MediaVideoProvider implements VideoGenerationProvider {
  readonly info: ProviderInfo;
  constructor(private readonly media: ServiceClient, private readonly mode: "kenburns" | "comfyui" | "animatediff") {
    this.info = {
      kenburns: { id: "kenburns", label: "Camera motion over still pictures (FFmpeg, NOT AI animation)", capability: "video" as const, paid: false, local: true },
      animatediff: { id: "animatediff-lcm", label: "AnimateDiff real AI animation (local CPU, slow: ~2 s of motion per scene)", capability: "video" as const, paid: false, local: true },
      comfyui: { id: "comfyui-img2vid", label: "ComfyUI image-to-video SVD (needs NVIDIA GPU)", capability: "video" as const, paid: false, local: true },
    }[mode];
  }
  async animate(r: AnimateRequest) {
    const res = await this.media.call<{ key: string; mode: string; motion_sec?: number }>("/animate", {
      image_key: r.imageKey, duration: r.durationSec, camera: r.camera, prompt: r.prompt, mode: this.mode, out_key: r.outKey,
      negative_prompt: r.negativePrompt ?? "", reference_keys: r.referenceKeys ?? [], ref_weight: r.referenceWeight, seed: r.seed ?? 0,
    }, 3 * 60 * 60_000);
    return { key: res.key, mode: res.mode, motionSec: res.motion_sec ?? 0 };
  }
  async health(): Promise<ProviderHealth> {
    const h = await mediaHealth(this.media);
    if ("error" in h) return { ok: false, detail: h.error };
    if (this.mode === "kenburns") return { ok: h.ffmpeg, detail: h.ffmpeg ? "FFmpeg ready" : "FFmpeg missing in media-service" };
    if (this.mode === "animatediff") {
      const ok = h.comfyui.ok && (h.comfyui.runnable ?? []).includes("animatediff");
      return { ok, detail: ok ? `${h.comfyui.detail}; AnimateDiff ready` : "AnimateDiff not runnable: needs ComfyUI-AnimateDiff-Evolved + v3_sd15_mm.ckpt in models/animatediff_models" };
    }
    const runnable = (h.comfyui.runnable ?? h.comfyui.workflows).includes("img2vid");
    return { ok: h.comfyui.ok && runnable, detail: runnable ? h.comfyui.detail : "img2vid not runnable: workflow, nodes or SVD model missing (needs an NVIDIA GPU)" };
  }
}

export class MediaVoiceProvider implements VoiceGenerationProvider {
  readonly info: ProviderInfo = { id: "local-tts", label: "Kokoro / Piper (local)", capability: "voice", paid: false, local: true };
  constructor(private readonly media: ServiceClient) {}
  async synthesize(r: VoiceRequest) {
    const res = await this.media.call<{ key: string; duration: number; words: Word[] }>("/tts", {
      text: r.text, engine: r.engine, voice: r.voiceId, speed: r.speed, language: r.language, out_key: r.outKey,
    });
    return { key: res.key, durationSec: res.duration, words: res.words };
  }
  listVoices() {
    return this.media.call<{ engine: string; id: string; name: string; language: string }[]>("/voices", undefined, 30_000);
  }
  async health(): Promise<ProviderHealth> {
    const h = await mediaHealth(this.media);
    if ("error" in h) return { ok: false, detail: h.error };
    const engines = [h.tts.kokoro && "kokoro", h.tts.piper && "piper"].filter(Boolean);
    return { ok: engines.length > 0, detail: engines.length ? `engines: ${engines.join(", ")}` : "no TTS engine installed" };
  }
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly info: ProviderInfo = { id: "faster-whisper", label: "faster-whisper (local)", capability: "transcription", paid: false, local: true };
  constructor(private readonly media: ServiceClient) {}
  transcribe(key: string, language?: string) {
    return this.media.call<{ text: string; language: string; words: Word[] }>("/transcribe", { key, language: language ?? null });
  }
  async health(): Promise<ProviderHealth> {
    const h = await mediaHealth(this.media);
    if ("error" in h) return { ok: false, detail: h.error };
    return { ok: h.whisper.ok, detail: h.whisper.ok ? `model ${h.whisper.model}` : "faster-whisper not available" };
  }
}

/** Agent Reach + yt-dlp + FFmpeg + whisper, isolated in reference-service (cookies never leave it). */
export class AgentReachReferenceProvider implements ReferenceExtractionProvider {
  readonly info: ProviderInfo = { id: "reference-service", label: "Agent Reach + yt-dlp (local service)", capability: "reference", paid: false, local: true };
  constructor(private readonly ref: ServiceClient) {}
  extractUrl(url: string, workKey: string) {
    return this.ref.call<ExtractionResult>("/extract", { url, work_key: workKey });
  }
  processUpload(videoKey: string, workKey: string) {
    return this.ref.call<ExtractionResult>("/process-upload", { video_key: videoKey, work_key: workKey });
  }
  async health(): Promise<ProviderHealth> {
    try {
      const h = await this.ref.call<{ ok: boolean; agent_reach: { installed: boolean; version: string | null }; ytdlp: boolean; ffmpeg: boolean }>("/health", undefined, 8000);
      return { ok: h.ok, detail: `agent-reach ${h.agent_reach.installed ? h.agent_reach.version ?? "installed" : "missing"}, yt-dlp ${h.ytdlp ? "ok" : "missing"}, ffmpeg ${h.ffmpeg ? "ok" : "missing"}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ---------------- editing / rendering (FFmpeg in media-service; not an AI provider) ---------------- */

export interface ComposeScene { clip_key: string; duration: number; start: number; transition: string; transition_sec: number; on_screen_text: string; sfx_key: string | null }
export interface ComposeVoice { key: string; start: number; duration: number; words: Word[] }
export interface RenderValidation {
  ok: boolean; problems: string[]; width: number | null; height: number | null; fps: number | null;
  video_codec: string | null; audio_codec: string | null; duration: number | null; black_ratio: number | null;
}

export class MediaComposer {
  constructor(private readonly media: ServiceClient) {}
  /** media-service health (ComfyUI workflows installed, TTS engines, ffmpeg); throws when the service is down */
  async health(): Promise<MediaHealth> {
    const h = await mediaHealth(this.media);
    if ("error" in h) throw new Error(h.error);
    return h;
  }
  compose(req: { work_key: string; scenes: ComposeScene[]; voices: ComposeVoice[]; music_key: string | null; whoosh_key: string | null; end_card: string; total_sec: number; out_key: string }) {
    return this.media.call<{ key: string; duration: number; validation: RenderValidation }>("/compose", req);
  }
  thumbnail(imageKey: string, text: string, outKey: string) {
    return this.media.call<{ key: string }>("/thumbnail", { image_key: imageKey, text, out_key: outKey });
  }
  /** Unloads the image model before LLM work (16 GB machine: never hold both in RAM). Best effort. */
  async freeImageModel() {
    try { await this.media.call<{ comfyui_freed: boolean }>("/free", {}, 60_000); } catch { /* media-service down: nothing to free */ }
  }
  /** Unpacks a clip made outside ReelForge (Google Flow / Veo): duration, audio track, still frame. */
  clipAssets(videoKey: string, outPrefix: string) {
    return this.media.call<{ duration: number; has_audio: boolean; audio_key: string | null; frame_key: string }>("/clip-assets", { video_key: videoKey, out_prefix: outPrefix }, 10 * 60_000);
  }
  pickLibrary(kind: "music" | "sfx", query: string, salt: string) {
    return this.media.call<{ key: string | null }>("/library/pick", { kind, query, salt }, 60_000);
  }
}
