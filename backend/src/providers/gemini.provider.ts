import { Logger } from "@nestjs/common";
import { z } from "zod";
import type { ProviderHealth, ProviderInfo, TextGenerationProvider, TextInput } from "./types.ts";
import { ProviderUnavailableError } from "./types.ts";
import { describeFetchError, isConnectionRefused, longFetch } from "./http.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart { text?: string; thought?: boolean }
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}
interface GeminiError { error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] } }

/** Free-tier quota for the day is used up: no point waiting, hand the request to the fallback. */
class DailyQuotaError extends Error {}

/**
 * Google Gemini through the free tier of the Gemini API (a key from aistudio.google.com, no billing needed).
 * A cloud model writes a story in about a minute instead of hours on a CPU, and follows instructions
 * (cast, length, language) far better than a local 7B model.
 *
 * Free-tier limits: short bursts are throttled (HTTP 429 with a retry delay), so requests wait and retry.
 * When the DAILY quota is used up, or Google can't be reached, the request goes to the fallback provider
 * (local Ollama) so a reel never fails because of the quota.
 */
export class GeminiTextProvider implements TextGenerationProvider {
  readonly info: ProviderInfo = { id: "gemini", label: "Google Gemini (free tier, cloud)", capability: "text", paid: false, local: false };
  private readonly log = new Logger("Gemini");

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fallback: TextGenerationProvider | null,
  ) {}

  async generateJson<S extends z.ZodType>(input: TextInput, schema: S, opts: { maxTokens?: number; temperature?: number } = {}) {
    if (!this.apiKey) {
      if (this.fallback) return this.fallback.generateJson(input, schema, opts);
      throw new ProviderUnavailableError("GEMINI_API_KEY is not set in backend/.env");
    }
    try {
      return await this.generate(input, schema, opts);
    } catch (e) {
      const offline = e instanceof ProviderUnavailableError;
      if (this.fallback && (e instanceof DailyQuotaError || offline)) {
        this.log.warn(`${e.message} - using ${this.fallback.info.label} for this request`);
        return this.fallback.generateJson(input, schema, opts);
      }
      throw e;
    }
  }

  private async generate<S extends z.ZodType>(input: TextInput, schema: S, opts: { maxTokens?: number; temperature?: number }) {
    const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
    const userParts: Record<string, unknown>[] = [{ text: input.prompt }];
    for (const img of input.images ?? []) userParts.push({ inlineData: { mimeType: imageMime(img), data: img } });
    const contents: { role: string; parts: Record<string, unknown>[] }[] = [{ role: "user", parts: userParts }];
    // thinking tokens count against maxOutputTokens on Gemini, so the budget is generous; the schema keeps answers tight
    const maxOutputTokens = Math.min(65_536, Math.max(8192, (opts.maxTokens ?? 4096) * 3));
    let useSchema = true;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const body = {
        systemInstruction: { parts: [{ text: `${input.system}\n\nRespond ONLY with one JSON object matching the provided schema.${useSchema ? "" : `\nJSON schema:\n${JSON.stringify(jsonSchema)}`}` }] },
        contents,
        generationConfig: {
          responseMimeType: "application/json",
          ...(useSchema ? { responseJsonSchema: jsonSchema } : {}),
          temperature: opts.temperature ?? 0.8,
          maxOutputTokens,
        },
      };
      let res: GeminiResponse;
      try {
        res = await this.call(body);
      } catch (e) {
        // a schema feature Gemini doesn't support: describe the schema in the prompt instead
        if (useSchema && e instanceof SchemaRejectedError) { useSchema = false; attempt--; continue; }
        throw e;
      }
      outputTokens += (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);
      const cand = res.candidates?.[0];
      if (!cand) throw new Error(`Gemini returned no answer${res.promptFeedback?.blockReason ? ` (blocked: ${res.promptFeedback.blockReason})` : ""}`);
      const raw = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, "");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const r = schema.safeParse(parsed);
      if (r.success) return { data: r.data as z.infer<S>, model: this.model, outputTokens };
      if (cand.finishReason === "MAX_TOKENS" && attempt === 3) throw new Error(`Gemini output was cut off at ${maxOutputTokens} tokens`);
      if (attempt === 3) throw new Error(`Gemini returned JSON that doesn't match the schema: ${issues(r.error)}`);
      // one repair round with the validation errors (same approach as the Ollama provider)
      contents.push({ role: "model", parts: [{ text: raw || "{}" }] }, { role: "user", parts: [{ text: `Invalid: ${issues(r.error)}. Return the corrected complete JSON object.` }] });
    }
    throw new Error("unreachable");
  }

  /** One API call; free-tier rate limits (429) wait for Google's retry delay and try again. */
  private async call(body: unknown): Promise<GeminiResponse> {
    for (let attempt = 1; ; attempt++) {
      let res: Awaited<ReturnType<typeof longFetch>>;
      try {
        res = await longFetch(`${API}/models/${encodeURIComponent(this.model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (e) {
        if (isConnectionRefused(e)) throw new ProviderUnavailableError(`Gemini API unreachable (${describeFetchError(e)})`);
        if (attempt < 3) { await sleep(5000 * attempt); continue; }
        throw new ProviderUnavailableError(`Gemini request failed: ${describeFetchError(e)}`);
      }
      if (res.ok) return (await res.json()) as GeminiResponse;

      const text = await res.text();
      let err: GeminiError["error"];
      try { err = (JSON.parse(text) as GeminiError).error; } catch { err = undefined; }
      const msg = err?.message ?? text.slice(0, 300);
      if (res.status === 429) {
        const quotaIds = (err?.details ?? []).flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "");
        if (quotaIds.some((q) => /PerDay/i.test(q))) throw new DailyQuotaError(`Gemini free-tier daily quota used up (${this.model})`);
        const delay = (err?.details ?? []).find((d) => d.retryDelay)?.retryDelay;
        const waitMs = Math.min(120_000, delay ? Math.ceil(parseFloat(delay) * 1000) + 1000 : 15_000 * attempt);
        if (attempt <= 8) { this.log.log(`rate limited, retrying in ${Math.round(waitMs / 1000)} s`); await sleep(waitMs); continue; }
        throw new DailyQuotaError(`Gemini kept rate-limiting (${msg})`);
      }
      if (res.status >= 500 && attempt < 4) { await sleep(5000 * attempt); continue; }
      if (res.status === 400 && /schema|response_json_schema|responseJsonSchema/i.test(msg)) throw new SchemaRejectedError(msg);
      if (res.status === 400 && /api key/i.test(msg)) throw new Error("Gemini rejected the API key: check GEMINI_API_KEY in backend/.env");
      if (res.status === 404) throw new Error(`Gemini model "${this.model}" not found: check GEMINI_TEXT_MODEL in backend/.env`);
      throw new Error(`Gemini returned ${res.status}: ${msg}`);
    }
  }

  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) return { ok: false, detail: "GEMINI_API_KEY not set in backend/.env (free key: aistudio.google.com)" };
    try {
      const res = await fetch(`${API}/models/${encodeURIComponent(this.model)}`, { headers: { "x-goog-api-key": this.apiKey }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true, detail: `${this.model}${this.fallback ? ` (falls back to ${this.fallback.info.label})` : ""}` };
      if (res.status === 404) return { ok: false, detail: `model "${this.model}" not found` };
      return { ok: false, detail: res.status === 400 || res.status === 403 ? "API key rejected" : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: `Gemini unreachable: ${e instanceof Error ? e.message : e}` };
    }
  }
}

class SchemaRejectedError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const issues = (e: z.ZodError) => e.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

/** Base64 images arrive without a type: read it from the first bytes. */
function imageMime(b64: string): string {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}
