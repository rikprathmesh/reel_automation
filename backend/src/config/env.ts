import { z } from "zod";

/**
 * Environment contract. Validated once at boot; the process exits with a readable
 * list of problems instead of failing later in a random module.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("127.0.0.1"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  /** Base URL OAuth providers redirect to (the frontend origin when using Next.js rewrites). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().startsWith("postgresql://", "must be a postgresql:// URL"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  /** Signs session JWTs. */
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  JWT_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  /** Encrypts OAuth tokens at rest (AES-256-GCM). */
  TOKEN_ENCRYPTION_KEY: z.string().min(32, "must be at least 32 characters"),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_ROOT: z.string().default("../storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(300),

  MEDIA_SERVICE_URL: z.string().url().default("http://127.0.0.1:8000"),
  COMFYUI_URL: z.string().url().default("http://127.0.0.1:8188"),
  REFERENCE_SERVICE_URL: z.string().url().default("http://127.0.0.1:8100"),
  SERVICE_TOKEN: z.string().default(""),

  OLLAMA_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_TEXT_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_VISION_MODEL: z.string().default("qwen2.5vl:3b"),

  TZ_NAME: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  IG_GRAPH_VERSION: z.string().default("v27.0"),
});

export type AppEnv = z.infer<typeof Env>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const r = Env.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration in backend/.env (variables are documented in src/config/env.ts):\n${lines}`);
  }
  return r.data;
}
