import type { z } from "zod";

/**
 * Provider interfaces. The pipeline depends only on these; concrete adapters (Ollama, ComfyUI via the
 * media service, Kokoro/Piper, faster-whisper, Agent Reach via the reference service, …) are registered
 * in ProviderRegistry and selected per capability in Settings.
 */

export interface ProviderHealth { ok: boolean; detail: string }

export interface ProviderInfo {
  id: string;
  label: string;
  capability: Capability;
  /** Paid providers are never selected by default and need explicit confirmation to enable. */
  paid: boolean;
  local: boolean;
}

export type Capability = "text" | "image" | "video" | "voice" | "transcription" | "reference";

interface BaseProvider { readonly info: ProviderInfo; health(): Promise<ProviderHealth> }

export interface TextInput { system: string; prompt: string; images?: string[] /* base64 */ }
export interface TextGenerationProvider extends BaseProvider {
  generateJson<S extends z.ZodType>(input: TextInput, schema: S, opts?: { maxTokens?: number; temperature?: number }): Promise<{ data: z.infer<S>; model: string; outputTokens: number }>;
}

export interface ImageRequest {
  prompt: string; negativePrompt: string; referenceKeys: string[]; seed: number; width: number; height: number; outKey: string;
  /** IP-Adapter strength for referenceKeys (0-1); omitted = media-service default */
  referenceWeight?: number;
}
export interface ImageGenerationProvider extends BaseProvider {
  generate(req: ImageRequest): Promise<{ key: string; workflow: string }>;
}

export type CameraMove = "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "pan_up" | "pan_down" | "static";
export interface AnimateRequest {
  imageKey: string; durationSec: number; camera: CameraMove; prompt: string; outKey: string;
  /** AI video models only: character reference images, negative prompt, seed */
  negativePrompt?: string; referenceKeys?: string[]; referenceWeight?: number; seed?: number;
}
export interface VideoGenerationProvider extends BaseProvider {
  /** motionSec = seconds of real AI motion in the clip (0 for camera motion over a still) */
  animate(req: AnimateRequest): Promise<{ key: string; mode: string; motionSec: number }>;
}

export interface Word { word: string; start: number; end: number }
export interface VoiceRequest { text: string; voiceId: string; engine: string; speed: number; language: string; outKey: string }
export interface VoiceGenerationProvider extends BaseProvider {
  synthesize(req: VoiceRequest): Promise<{ key: string; durationSec: number; words: Word[] }>;
  listVoices(): Promise<{ engine: string; id: string; name: string; language: string }[]>;
}

export interface TranscriptionProvider extends BaseProvider {
  transcribe(key: string, language?: string): Promise<{ text: string; language: string; words: Word[] }>;
}

export interface ExtractionResult {
  ok: boolean;
  extractor: string;
  title: string | null;
  author: string | null;
  caption: string | null;
  transcript: string | null;
  durationSec: number | null;
  metadata: Record<string, unknown>;
  frameKeys: string[];
  videoKey: string | null;
  thumbnailKey: string | null;
  transcriptLanguage: string | null;
  cuts: number[];
  warnings: string[];
  /** When ok=false: what failed and what the user can do (e.g. upload the video). */
  error: string | null;
}
export interface ReferenceExtractionProvider extends BaseProvider {
  extractUrl(url: string, workKey: string): Promise<ExtractionResult>;
  processUpload(videoKey: string, workKey: string): Promise<ExtractionResult>;
}

export interface CapabilityMap {
  text: TextGenerationProvider;
  image: ImageGenerationProvider;
  video: VideoGenerationProvider;
  voice: VoiceGenerationProvider;
  transcription: TranscriptionProvider;
  reference: ReferenceExtractionProvider;
}

export class ProviderUnavailableError extends Error {}
