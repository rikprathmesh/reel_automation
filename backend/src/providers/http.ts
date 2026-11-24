import { Agent, fetch as undiciFetch } from "undici";

/**
 * Node's global fetch gives up waiting for response headers after 300 s. Local AI work
 * (a 10-minute Ollama script, a Whisper transcription) legitimately takes longer, so internal
 * calls use this agent with no header/body timeout; each call passes its own AbortSignal deadline.
 */
const longAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 });

export function longFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) {
  return undiciFetch(url, { ...init, dispatcher: longAgent });
}

/** True when the failure means "nothing is listening", as opposed to a timeout or a server error. */
export function isConnectionRefused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND" || cause?.code === "UND_ERR_CONNECT_TIMEOUT";
}

export function describeFetchError(e: unknown): string {
  if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return "timed out";
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ? `${cause.code}${cause.message ? `: ${cause.message}` : ""}` : e instanceof Error ? e.message : String(e);
}
