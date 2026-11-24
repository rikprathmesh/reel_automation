import { ProviderUnavailableError } from "./types.ts";
import { describeFetchError, isConnectionRefused, longFetch } from "./http.ts";

/**
 * HTTP client for the internal Python services (media-service, reference-service).
 * Sends the shared X-Service-Token. "Not running" becomes ProviderUnavailableError (503 in the API);
 * timeouts and server errors are reported as what they are.
 */
export class ServiceClient {
  constructor(private readonly name: string, private readonly baseUrl: string, private readonly token: string) {}

  async call<T>(path: string, body?: unknown, timeoutMs = 60 * 60_000): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["X-Service-Token"] = this.token;
    let res: Awaited<ReturnType<typeof longFetch>>;
    try {
      res = await longFetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (isConnectionRefused(e)) throw new ProviderUnavailableError(`${this.name} is not running at ${this.baseUrl}`);
      throw new Error(`${this.name} ${path} failed: ${describeFetchError(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { const j = JSON.parse(text) as { detail?: unknown }; detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j); } catch { /* plain text */ }
      throw new Error(`${this.name} ${path} failed (${res.status}): ${detail.slice(0, 800)}`);
    }
    return JSON.parse(text) as T;
  }
}
