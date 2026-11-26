/**
 * Instagram Graph API (official) for an Instagram Professional account linked to a Facebook Page.
 * Reels are published with a resumable upload of the local file (no public URL needed):
 * create REELS container → upload bytes to rupload → poll status → media_publish.
 */
export interface IgCredentials { accessToken: string; igUserId: string }

// Per Meta docs (Instagram API with Facebook Login): publishing needs instagram_basic, instagram_content_publish, pages_read_engagement;
// pages_show_list finds the linked Page; instagram_manage_insights powers analytics.
const SCOPES = ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "pages_show_list", "instagram_manage_insights"];

async function j<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: number } } | null)?.error;
    throw new Error(`Instagram ${what} failed (${res.status}${err?.code ? `/${err.code}` : ""}): ${err?.message ?? text.slice(0, 300)}`);
  }
  return body as T;
}

export class InstagramClient {
  constructor(private readonly appId: string, private readonly appSecret: string, private readonly version: string, private readonly redirectUri: string) {}

  private get graph() {
    return `https://graph.facebook.com/${this.version}`;
  }
  get oauthConfigured() {
    return Boolean(this.appId && this.appSecret);
  }

  /**
   * "Facebook Login for Business" login URL, exactly as documented for the Instagram API
   * (business-login-for-instagram): display=page, extras IG_API_ONBOARDING, response_type=token.
   * Meta returns the tokens in the URL *fragment* of redirect_uri, which only the browser can read;
   * the frontend page at redirect_uri posts the long-lived token to the backend.
   */
  authUrl(state: string) {
    const q = new URLSearchParams({
      client_id: this.appId,
      display: "page",
      extras: JSON.stringify({ setup: { channel: "IG_API_ONBOARDING" } }),
      redirect_uri: this.redirectUri,
      response_type: "token",
      scope: SCOPES.join(","),
      state,
    });
    return `https://www.facebook.com/${this.version}/dialog/oauth?${q}`;
  }

  private async longLived(token: string) {
    if (!this.oauthConfigured) return { access_token: token, expires_in: undefined as number | undefined };
    const q = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: token });
    return j<{ access_token: string; expires_in?: number }>(await fetch(`${this.graph}/oauth/access_token?${q}`), "token exchange");
  }

  /**
   * Completes Business Login: the browser hands over the long-lived user token from the URL fragment.
   * The token is verified against THIS app (debug_token) before it is trusted.
   */
  async connectFromLogin(longLivedToken: string) {
    if (this.oauthConfigured) {
      const appToken = `${this.appId}|${this.appSecret}`;
      const dbg = await j<{ data: { app_id?: string; is_valid?: boolean; expires_at?: number; granular_scopes?: { scope: string; target_ids?: string[] }[] } }>(
        await fetch(`${this.graph}/debug_token?input_token=${encodeURIComponent(longLivedToken)}&access_token=${encodeURIComponent(appToken)}`), "token check");
      if (!dbg.data.is_valid || dbg.data.app_id !== this.appId) throw new Error("The returned token is not valid for this Meta app");
      // The token lists exactly which IG accounts the user granted. Using it directly also works when the Page
      // sits in a Business portfolio, where /me/accounts comes back empty.
      const granted = dbg.data.granular_scopes?.find((g) => (g.scope === "instagram_content_publish" || g.scope === "instagram_basic") && g.target_ids?.length);
      const r = await this.connect(longLivedToken, granted?.target_ids?.[0]);
      // connect() swaps the token for a ~60-day one; its expiry wins over the expiry of the token Meta handed back
      return { ...r, expiresAt: r.expiresAt ?? (dbg.data.expires_at ? new Date(dbg.data.expires_at * 1000) : new Date(Date.now() + 60 * 86400_000)) };
    }
    return this.connect(longLivedToken);
  }

  /** Validates a token and finds the IG professional account behind the user's Facebook Pages. */
  async connect(token: string, igUserId?: string) {
    const long = await this.longLived(token).catch(() => ({ access_token: token, expires_in: undefined as number | undefined }));
    const t = long.access_token;
    let acct: { id: string; username: string };
    if (igUserId) {
      acct = await j(await fetch(`${this.graph}/${encodeURIComponent(igUserId)}?fields=id,username&access_token=${encodeURIComponent(t)}`), "account lookup");
    } else {
      const pages = await j<{ data: { name: string; instagram_business_account?: { id: string; username?: string } }[] }>(
        await fetch(`${this.graph}/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(t)}`), "page lookup");
      const p = pages.data.find((x) => x.instagram_business_account);
      if (!pages.data.length) throw new Error("This login did not grant access to any Facebook Page or Instagram account. On Facebook open Settings → Business integrations → your Meta app → View and edit, turn on your Page and Instagram account (or remove the app), then click Connect again. Your Instagram Professional account must also be linked to a Facebook Page.");
      if (!p?.instagram_business_account) throw new Error(`None of your allowed Facebook Pages (${pages.data.map((x) => x.name).join(", ")}) has an Instagram Professional account linked. Link your Instagram Business/Creator account to one of them (Page settings → Linked accounts → Instagram), then connect again.`);
      acct = { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? p.name };
    }
    return { credentials: { accessToken: t, igUserId: acct.id } satisfies IgCredentials, username: acct.username, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null };
  }

  async publishReel(c: IgCredentials, bytes: Buffer, caption: string) {
    const create = await j<{ id: string; uri?: string }>(await fetch(`${this.graph}/${c.igUserId}/media`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: "REELS", upload_type: "resumable", caption: caption.slice(0, 2200), share_to_feed: true, access_token: c.accessToken }),
    }), "create container");
    const uploadUri = create.uri ?? `https://rupload.facebook.com/ig-api-upload/${this.version}/${create.id}`;
    await j(await fetch(uploadUri, {
      method: "POST",
      headers: { Authorization: `OAuth ${c.accessToken}`, offset: "0", file_size: String(bytes.length), "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    }), "video upload");
    // Meta recommends checking container status about once a minute
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const st = await j<{ status_code?: string; status?: string }>(await fetch(`${this.graph}/${create.id}?fields=status_code,status&access_token=${encodeURIComponent(c.accessToken)}`), "status check");
      if (st.status_code === "FINISHED") break;
      if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`Instagram processing failed: ${st.status ?? st.status_code}`);
      if (Date.now() > deadline) throw new Error("Instagram processing timed out");
      await new Promise((r) => setTimeout(r, 30_000));
    }
    const pub = await j<{ id: string }>(await fetch(`${this.graph}/${c.igUserId}/media_publish`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creation_id: create.id, access_token: c.accessToken }),
    }), "publish");
    const info = await fetch(`${this.graph}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(c.accessToken)}`).then((r) => r.json() as Promise<{ permalink?: string }>).catch(() => ({ permalink: undefined }));
    return { remoteId: pub.id, url: info.permalink ?? null };
  }

  async insights(c: IgCredentials, mediaId: string) {
    const res = await fetch(`${this.graph}/${mediaId}/insights?metric=views,reach,likes,comments,shares,saved&access_token=${encodeURIComponent(c.accessToken)}`);
    if (res.ok) {
      const d = (await res.json()) as { data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] };
      const m = Object.fromEntries(d.data.map((x) => [x.name, x.values?.[0]?.value ?? x.total_value?.value ?? null])) as Record<string, number | null>;
      return { views: m.views ?? null, reach: m.reach ?? null, likes: m.likes ?? null, comments: m.comments ?? null, shares: m.shares ?? null, saves: m.saved ?? null, raw: d };
    }
    const basic = await j<{ like_count?: number; comments_count?: number }>(await fetch(`${this.graph}/${mediaId}?fields=like_count,comments_count&access_token=${encodeURIComponent(c.accessToken)}`), "media lookup");
    return { views: null, reach: null, likes: basic.like_count ?? null, comments: basic.comments_count ?? null, shares: null, saves: null, raw: basic };
  }
}
