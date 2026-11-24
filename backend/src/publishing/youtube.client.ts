import { google, type Auth, type youtube_v3 } from "googleapis";
import type { Readable } from "node:stream";

/** YouTube Data API v3 (official). Scopes: upload + read-only (for stats). */
export const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

export class YouTubeClient {
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly redirectUri: string) {}

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  private oauth(tokens?: Auth.Credentials) {
    const c = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    if (tokens) c.setCredentials(tokens);
    return c;
  }

  authUrl(state: string) {
    return this.oauth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: YT_SCOPES, state, include_granted_scopes: true });
  }

  async exchange(code: string) {
    const c = this.oauth();
    const { tokens } = await c.getToken(code);
    c.setCredentials(tokens);
    const me = await google.youtube({ version: "v3", auth: c }).channels.list({ part: ["snippet"], mine: true });
    const ch = me.data.items?.[0];
    if (!ch?.id) throw new Error("This Google account has no YouTube channel");
    return { tokens, channelId: ch.id, channelTitle: ch.snippet?.title ?? ch.id };
  }

  /** Returns an API client; refreshed tokens are reported through onTokens so they can be re-encrypted and stored. */
  api(tokens: Auth.Credentials, onTokens: (t: Auth.Credentials) => void): youtube_v3.Youtube {
    const c = this.oauth(tokens);
    c.on("tokens", (t) => onTokens({ ...tokens, ...t }));
    return google.youtube({ version: "v3", auth: c });
  }

  async upload(yt: youtube_v3.Youtube, input: { body: Readable; title: string; description: string; tags: string[]; privacy: "private" | "unlisted" | "public" }) {
    const description = /#shorts/i.test(input.description) ? input.description : `${input.description}\n\n#Shorts`;
    const res = await yt.videos.insert({
      part: ["snippet", "status"],
      notifySubscribers: input.privacy === "public",
      requestBody: {
        snippet: { title: input.title.slice(0, 100), description: description.slice(0, 4900), tags: input.tags.map((t) => t.replace(/^#/, "")).slice(0, 30), categoryId: "1" },
        status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      },
      media: { mimeType: "video/mp4", body: input.body },
    });
    if (!res.data.id) throw new Error("YouTube returned no video id");
    return { remoteId: res.data.id, url: `https://www.youtube.com/shorts/${res.data.id}` };
  }

  async stats(yt: youtube_v3.Youtube, ids: string[]) {
    const out = new Map<string, { views: number; likes: number; comments: number; raw: unknown }>();
    for (let i = 0; i < ids.length; i += 50) {
      const res = await yt.videos.list({ part: ["statistics"], id: ids.slice(i, i + 50) });
      for (const v of res.data.items ?? []) {
        const s = v.statistics ?? {};
        out.set(v.id!, { views: Number(s.viewCount ?? 0), likes: Number(s.likeCount ?? 0), comments: Number(s.commentCount ?? 0), raw: s });
      }
    }
    return out;
  }
}
