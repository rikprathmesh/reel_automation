import { z } from "zod";
import type { ProviderHealth, ProviderInfo, TextGenerationProvider, TextInput } from "./types.ts";
import { ProviderUnavailableError } from "./types.ts";
import { describeFetchError, isConnectionRefused, longFetch } from "./http.ts";

interface ChatResponse { message: { content: string }; eval_count?: number; done_reason?: string }

/**
 * Local LLM through Ollama with JSON-schema-constrained output.
 * keep_alive=0 unloads the model after each call so the image model has RAM (16 GB machine).
 */
export class OllamaTextProvider implements TextGenerationProvider {
  readonly info: ProviderInfo = { id: "ollama", label: "Ollama (local)", capability: "text", paid: false, local: true };

  constructor(private readonly url: string, private readonly textModel: string, private readonly visionModel: string) {}

  async generateJson<S extends z.ZodType>(input: TextInput, schema: S, opts: { maxTokens?: number; temperature?: number } = {}) {
    const model = input.images?.length ? this.visionModel : this.textModel;
    const format = z.toJSONSchema(schema, { target: "draft-7" });
    const messages: { role: string; content: string; images?: string[] }[] = [
      { role: "system", content: `${input.system}\n\nRespond ONLY with one JSON object matching the provided schema.` },
      { role: "user", content: input.prompt, ...(input.images?.length ? { images: input.images } : {}) },
    ];
    let outputTokens = 0;
    let budget = opts.maxTokens ?? 4096;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res: Awaited<ReturnType<typeof longFetch>>;
      try {
        res = await longFetch(`${this.url}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model, messages, format, stream: false, keep_alive: 0,
            options: { temperature: opts.temperature ?? 0.8, num_predict: budget, num_ctx: Math.max(8192, Math.min(16384, budget + 4096)) },
          }),
          signal: AbortSignal.timeout(45 * 60_000),
        });
      } catch (e) {
        if (isConnectionRefused(e)) throw new ProviderUnavailableError(`Ollama is not running at ${this.url}`);
        throw new Error(`Ollama ${model} request failed: ${describeFetchError(e)}`);
      }
      if (!res.ok) throw new Error(`Ollama ${model} returned ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = (await res.json()) as ChatResponse;
      outputTokens += body.eval_count ?? 0;
      const raw = body.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const r = schema.safeParse(parsed);
      if (r.success) return { data: r.data as z.infer<S>, model, outputTokens };
      if (body.done_reason === "length") {
        if (attempt === 2) throw new Error(`Ollama output was cut off at ${budget} tokens`);
        // small models sometimes ramble: one more try with more room and an explicit request to be brief
        budget = Math.min(12_000, Math.round(budget * 1.7));
        messages[messages.length - 1] = { ...messages[messages.length - 1]!, content: `${input.prompt}\n\nIMPORTANT: your previous answer was too long and was cut off. Keep every text field short (one brief phrase or sentence) and return the complete JSON object.` };
        continue;
      }
      if (attempt === 2) throw new Error(`Ollama returned JSON that doesn't match the schema: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      // one repair round with the validation errors
      messages.push({ role: "assistant", content: raw }, { role: "user", content: `Invalid: ${r.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Return the corrected complete JSON object.` });
    }
    throw new Error("unreachable");
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const tags = (await res.json()) as { models: { name: string }[] };
      const missing = [this.textModel, this.visionModel].filter((m) => !tags.models.some((t) => t.name === m || t.name === `${m}:latest`));
      return missing.length ? { ok: false, detail: `missing model(s): ${missing.join(", ")}` } : { ok: true, detail: `${this.textModel} + ${this.visionModel}` };
    } catch (e) {
      return { ok: false, detail: `Ollama unreachable: ${e instanceof Error ? e.message : e}` };
    }
  }
}
