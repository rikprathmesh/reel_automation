"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, Cpu, KeyRound } from "lucide-react";
import { api, errMsg, CATEGORY_LABELS, LANGUAGE_LABELS, type DailySchedule, type GenerationSettings } from "@/lib/api";
import { qk, useAccounts, useApiMutation, useIntegrations, useSaveGeneration, useSaveSchedule, useSettings } from "@/lib/queries";
import { PageHeader } from "@/components/page-header";
import { NativeSelect } from "@/components/native-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[220px_1fr] sm:items-center">
      <div><Label>{label}</Label>{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}</div>
      <div>{children}</div>
    </div>
  );
}

function GenerationTab({ initial, output }: { initial: GenerationSettings; output: { width: number; height: number; aspect: string; fps: number; videoCodec: string; audioCodec: string } }) {
  const [g, setG] = useState(initial);
  const save = useSaveGeneration();
  const togglePlatform = (p: "youtube" | "instagram", on: boolean) =>
    setG((s) => ({ ...s, defaultPlatforms: on ? [...new Set([...s.defaultPlatforms, p])] : s.defaultPlatforms.filter((x) => x !== p) }));
  return (
    <Card>
      <CardHeader><CardTitle>Generation defaults</CardTitle><CardDescription>Applied to every new story and reel.</CardDescription></CardHeader>
      <CardContent className="divide-y divide-border/60">
        <Row label="Language"><NativeSelect className="max-w-56" value={g.language} onChange={(e) => setG({ ...g, language: e.target.value as GenerationSettings["language"] })}>{Object.entries(LANGUAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Row>
        <Row label="Target duration" hint="Seconds, between 15 and 90.">
          <div className="flex max-w-56 items-center gap-2">
            <Input type="number" min={15} max={90} value={g.minDurationSec} onChange={(e) => setG({ ...g, minDurationSec: Number(e.target.value) })} />
            <span className="text-muted-foreground">to</span>
            <Input type="number" min={15} max={90} value={g.maxDurationSec} onChange={(e) => setG({ ...g, maxDurationSec: Number(e.target.value) })} />
          </div>
        </Row>
        <Row label="Output format" hint="Fixed for YouTube Shorts + Instagram Reels.">
          <div className="text-sm">{output.width} × {output.height} ({output.aspect}) · {output.fps} fps · {output.videoCodec} / {output.audioCodec} · MP4</div>
        </Row>
        <Row label="Default platforms">
          <div className="flex gap-5 text-sm">
            {(["youtube", "instagram"] as const).map((p) => (
              <label key={p} className="flex items-center gap-2"><Checkbox checked={g.defaultPlatforms.includes(p)} onCheckedChange={(v) => togglePlatform(p, Boolean(v))} />{p === "youtube" ? "YouTube Shorts" : "Instagram Reels"}</label>
            ))}
          </div>
        </Row>
        <Row label="YouTube privacy" hint="Start with private while testing.">
          <NativeSelect className="max-w-56" value={g.youtubePrivacy} onChange={(e) => setG({ ...g, youtubePrivacy: e.target.value as GenerationSettings["youtubePrivacy"] })}>
            <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
          </NativeSelect>
        </Row>
        <div className="pt-4">
          <Button disabled={save.isPending} onClick={() => save.mutate(g, { onSuccess: () => toast.success("Generation settings saved"), onError: (e) => toast.error(errMsg(e)) })}>Save</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduleTab({ initial }: { initial: DailySchedule }) {
  const { id: _id, ...rest } = initial;
  const [s, setS] = useState(rest);
  const save = useSaveSchedule();
  const toggleCat = (c: string, on: boolean) => setS((x) => ({ ...x, categories: on ? [...new Set([...x.categories, c])] : x.categories.filter((y) => y !== c) }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily automation</CardTitle>
        <CardDescription>Generates reels into the Review Studio. <b>It never publishes</b>; every reel still needs your approval.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        <Row label="Enabled" hint="Off by default. Turn on once a full reel renders reliably."><Switch checked={s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} /></Row>
        <Row label="Videos per day"><Input className="max-w-24" type="number" min={1} max={20} value={s.targetCount} onChange={(e) => setS({ ...s, targetCount: Number(e.target.value) })} /></Row>
        <Row label="Start time" hint="Runs overnight on this CPU-only laptop."><Input className="max-w-32" type="time" value={s.startTime} onChange={(e) => setS({ ...s, startTime: e.target.value })} /></Row>
        <Row label="Timezone"><Input className="max-w-56" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></Row>
        <Row label="Language"><NativeSelect className="max-w-56" value={s.language} onChange={(e) => setS({ ...s, language: e.target.value as DailySchedule["language"] })}>{Object.entries(LANGUAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Row>
        <Row label="Parallel jobs" hint="1 recommended without a GPU."><NativeSelect className="max-w-24" value={s.maxConcurrency} onChange={(e) => setS({ ...s, maxConcurrency: Number(e.target.value) })}><option value={1}>1</option><option value={2}>2</option></NativeSelect></Row>
        <Row label="Categories" hint="Rotated through the day's batch.">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <label key={k} className="flex items-center gap-2"><Checkbox checked={s.categories.includes(k)} onCheckedChange={(on) => toggleCat(k, Boolean(on))} />{v}</label>)}
          </div>
        </Row>
        <div className="pt-4">
          <Button disabled={save.isPending || s.categories.length === 0} onClick={() => save.mutate(s, { onSuccess: () => toast.success(s.enabled ? `Scheduled ${s.targetCount} reels daily at ${s.startTime}` : "Schedule saved (off)"), onError: (e) => toast.error(errMsg(e)) })}>Save schedule</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProvidersTab() {
  const integ = useIntegrations();
  const select = useApiMutation((v: { capability: string; providerId: string; confirmPaid: boolean }) => api.put("/integrations", v), [qk.integrations]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cpu className="size-4" /> AI providers</CardTitle>
        <CardDescription>Local, free providers are used by default. Paid services are never enabled without your explicit confirmation.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {integ.isPending && <Skeleton className="h-40" />}
        {integ.isError && <p className="text-sm text-red-400">{errMsg(integ.error)}</p>}
        {integ.data?.map((c) => (
          <div key={c.capability} className="rounded-lg border border-border/60 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{c.capability}</div>
            <div className="flex flex-col gap-2">
              {c.options.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/40">
                  <input type="radio" name={c.capability} className="mt-1 accent-[var(--color-primary)]" checked={c.selected === o.id}
                    onChange={() => {
                      const confirmPaid = o.paid ? confirm(`${o.label} is a PAID service. Enable it?`) : false;
                      if (o.paid && !confirmPaid) return;
                      select.mutate({ capability: c.capability, providerId: o.id, confirmPaid }, { onSuccess: () => toast.success(`${c.capability}: ${o.label}`), onError: (e) => toast.error(errMsg(e)) });
                    }} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">{o.label}{o.local && <Badge variant="secondary">local</Badge>}{o.paid && <Badge variant="destructive">paid</Badge>}</div>
                    <div className={`flex items-center gap-1 text-xs ${o.health.ok ? "text-emerald-400" : "text-amber-400"}`}>
                      {o.health.ok ? <CheckCircle2 className="size-3" /> : <CircleAlert className="size-3" />}{o.health.detail}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SocialTab() {
  const acc = useAccounts();
  const [token, setToken] = useState("");
  const [igUser, setIgUser] = useState("");
  const connectIg = useApiMutation((b: { accessToken: string; igUserId?: string }) => api.post<{ username: string }>("/publishing/accounts/instagram/token", b), [qk.accounts]);
  const disconnect = useApiMutation((p: string) => api.del(`/publishing/accounts/${p}`), [qk.accounts]);
  if (!acc.data) return <Skeleton className="h-60" />;
  const yt = acc.data.youtube, ig = acc.data.instagram;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>YouTube Shorts</CardTitle><CardDescription>Official YouTube Data API v3 with OAuth 2.0. Your password is never stored; the OAuth token is encrypted at rest.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {yt.account ? (
            <>
              <div>Connected: <b>{yt.account.accountName}</b> <Badge variant="secondary">{yt.account.status}</Badge></div>
              <div><Button variant="outline" size="sm" onClick={() => { if (confirm("Disconnect YouTube?")) disconnect.mutate("youtube", { onSuccess: () => toast.success("YouTube disconnected") }); }}>Disconnect</Button></div>
            </>
          ) : yt.oauthConfigured ? (
            <a href="/api/oauth/youtube/start"><Button>Connect YouTube</Button></a>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
              <b className="text-amber-300">Setup required.</b> In Google Cloud Console: create a project, enable <i>YouTube Data API v3</i>, configure the OAuth consent screen (External, add yourself as a test user), then create an OAuth client ID of type <i>Web application</i> with redirect URI <code>http://localhost:3000/api/oauth/youtube/callback</code>. Put <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>backend/.env</code> and restart the backend.
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Instagram Reels</CardTitle><CardDescription>Official Instagram Graph API. Requires an Instagram Professional (Business/Creator) account linked to a Facebook Page.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {ig.account ? (
            <>
              <div>Connected: <b>@{ig.account.accountName}</b> <Badge variant="secondary">{ig.account.status}</Badge>{ig.account.expiresAt && <span className="text-xs text-muted-foreground"> · token expires {new Date(ig.account.expiresAt).toLocaleDateString()}</span>}</div>
              <div><Button variant="outline" size="sm" onClick={() => { if (confirm("Disconnect Instagram?")) disconnect.mutate("instagram", { onSuccess: () => toast.success("Instagram disconnected") }); }}>Disconnect</Button></div>
            </>
          ) : (
            <>
              {ig.oauthConfigured && <a href="/api/oauth/instagram/start"><Button>Connect with Facebook Login</Button></a>}
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
                <b className="text-amber-300">Setup required.</b> Create a Meta app (developers.facebook.com) with the Instagram Graph API and the permissions <code>instagram_basic</code>, <code>instagram_content_publish</code> and <code>pages_show_list</code>. Either set <code>META_APP_ID</code> and <code>META_APP_SECRET</code> in <code>backend/.env</code> (redirect URI <code>http://localhost:3000/api/oauth/instagram/callback</code>), or paste a user access token below.
              </div>
              <Input type="password" placeholder="Instagram Graph API access token" value={token} onChange={(e) => setToken(e.target.value)} />
              <Input placeholder="Instagram user ID (optional, auto-detected)" value={igUser} onChange={(e) => setIgUser(e.target.value)} />
              <div><Button disabled={token.length < 20 || connectIg.isPending} onClick={() => connectIg.mutate({ accessToken: token, igUserId: igUser || undefined }, { onSuccess: (r) => { toast.success(`Instagram connected: @${r.username}`); setToken(""); }, onError: (e) => toast.error(errMsg(e)) })}>Connect</Button></div>
            </>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground lg:col-span-2">Without a connection, approved reels go to "Needs attention" in the Publishing Center, where you can download them, post manually and record the URL.</p>
    </div>
  );
}

function AccountTab() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const change = useApiMutation((v: { currentPassword: string; newPassword: string }) => api.post("/auth/password", v), []);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> Change password</CardTitle></CardHeader>
      <CardContent className="flex max-w-sm flex-col gap-3">
        <div className="flex flex-col gap-1.5"><Label>Current password</Label><Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="flex flex-col gap-1.5"><Label>New password (min 12 characters)</Label><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <Button disabled={change.isPending || next.length < 12 || !cur} onClick={() => change.mutate({ currentPassword: cur, newPassword: next }, { onSuccess: () => { toast.success("Password changed"); setCur(""); setNext(""); }, onError: (e) => toast.error(errMsg(e)) })}>Update password</Button>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const settings = useSettings();
  const [tab, setTab] = useState("generation");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab") ?? window.location.hash.slice(1);
    if (t) setTab(t);
    const connected = q.get("connected");
    if (connected) {
      const err = q.get("error");
      if (err) toast.error(`${connected} connection failed: ${err}`);
      else toast.success(`${connected} connected`);
      window.history.replaceState(null, "", "/settings?tab=social");
    }
  }, []);

  return (
    <>
      <PageHeader title="Settings" description="Generation defaults, automation, AI providers and accounts." />
      {settings.isError && <p className="text-sm text-red-400">{errMsg(settings.error)}</p>}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="generation">Generation</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="providers">AI providers</TabsTrigger>
          <TabsTrigger value="social">Social accounts</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>
        <TabsContent value="generation">{settings.data ? <GenerationTab initial={settings.data.generation} output={settings.data.output} /> : <Skeleton className="h-80" />}</TabsContent>
        <TabsContent value="schedule">{settings.data ? <ScheduleTab initial={settings.data.schedule} /> : <Skeleton className="h-80" />}</TabsContent>
        <TabsContent value="providers"><ProvidersTab /></TabsContent>
        <TabsContent value="social">
          <SocialTab />
        </TabsContent>
        <TabsContent value="account"><AccountTab /></TabsContent>
      </Tabs>
    </>
  );
}
