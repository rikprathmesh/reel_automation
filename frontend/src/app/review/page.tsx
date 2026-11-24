"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { CalendarClock, Check, CheckCircle2, Clapperboard, Download, MessageSquareWarning, RefreshCw, ShieldAlert, X } from "lucide-react";
import { ago, api, errMsg, CATEGORY_LABELS, LANGUAGE_LABELS, type Platform, type ReviewVersion } from "@/lib/api";
import { qk, useApiMutation, useReview } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const FILTERS = [
  ["ready", "Awaiting review"], ["approved", "Approved"], ["changes_requested", "Changes requested"], ["rejected", "Rejected"], ["all", "All"],
] as const;

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-sky-500/15 text-sky-300", approved: "bg-emerald-500/15 text-emerald-300", rejected: "bg-red-500/15 text-red-300",
  changes_requested: "bg-amber-500/15 text-amber-300",
};

function StatusPill({ status }: { status: string }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[status] ?? "bg-muted text-muted-foreground")}>{status.replace("_", " ")}</span>;
}

function ReelCard({ v, active, onClick }: { v: ReviewVersion; active: boolean; onClick: () => void }) {
  return (
    <motion.button layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} onClick={onClick}
      className={cn("group flex gap-3 rounded-xl border p-2 text-left transition-colors", active ? "border-primary/60 bg-primary/10" : "border-border/60 hover:bg-muted/40")}>
      <div className="aspect-9/16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
        {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="size-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <div className="line-clamp-2 text-sm font-medium">{v.project.story.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{CATEGORY_LABELS[v.project.story.category]}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <StatusPill status={v.status} /> v{v.versionNo} · {v.durationSec?.toFixed(0)}s · {ago(v.createdAt)}
        </div>
      </div>
    </motion.button>
  );
}

function MetadataEditor({ v }: { v: ReviewVersion }) {
  const [m, setM] = useState({ youtubeTitle: v.script.youtubeTitle, youtubeDescription: v.script.youtubeDescription, instagramCaption: v.script.instagramCaption, hashtags: v.script.hashtags.join(" ") });
  useEffect(() => setM({ youtubeTitle: v.script.youtubeTitle, youtubeDescription: v.script.youtubeDescription, instagramCaption: v.script.instagramCaption, hashtags: v.script.hashtags.join(" ") }), [v.id, v.script]);
  const save = useApiMutation((b: object) => api.patch(`/versions/${v.id}/metadata`, b), [["review"]]);
  const locked = v.publishingJobs.some((j) => ["uploading", "published"].includes(j.status));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5"><Label>YouTube title ({m.youtubeTitle.length}/100)</Label><Input maxLength={100} disabled={locked} value={m.youtubeTitle} onChange={(e) => setM({ ...m, youtubeTitle: e.target.value })} /></div>
      <div className="flex flex-col gap-1.5"><Label>YouTube description</Label><Textarea rows={4} disabled={locked} value={m.youtubeDescription} onChange={(e) => setM({ ...m, youtubeDescription: e.target.value })} /></div>
      <div className="flex flex-col gap-1.5"><Label>Instagram caption ({m.instagramCaption.length}/2200)</Label><Textarea rows={5} disabled={locked} maxLength={2200} value={m.instagramCaption} onChange={(e) => setM({ ...m, instagramCaption: e.target.value })} /></div>
      <div className="flex flex-col gap-1.5"><Label>Hashtags (space-separated)</Label><Input disabled={locked} value={m.hashtags} onChange={(e) => setM({ ...m, hashtags: e.target.value })} /></div>
      <div>
        <Button disabled={locked || save.isPending} onClick={() => save.mutate({ ...m, hashtags: m.hashtags.split(/\s+/).filter(Boolean) }, { onSuccess: () => toast.success("Title & captions saved"), onError: (e) => toast.error(errMsg(e)) })}>
          {save.isPending ? "Saving…" : "Save title & captions"}
        </Button>
        {locked && <span className="ml-3 text-xs text-muted-foreground">Locked — already publishing</span>}
      </div>
    </div>
  );
}

function ApprovePanel({ v }: { v: ReviewVersion }) {
  const [platforms, setPlatforms] = useState<Platform[]>(v.project.targetPlatforms.length ? v.project.targetPlatforms : ["youtube", "instagram"]);
  const [schedule, setSchedule] = useState("");
  const approve = useApiMutation((b: object) => api.post(`/versions/${v.id}/approve`, b), [["review"], ["publishing"], ["stats"]]);
  const canApprove = ["ready", "approved"].includes(v.status) && Boolean(v.validation?.ok);
  const toggle = (p: Platform, on: boolean) => setPlatforms((x) => (on ? [...new Set([...x, p])] : x.filter((y) => y !== p)));
  if (!canApprove) {
    return <p className="text-sm text-muted-foreground">{v.status === "rejected" ? "Rejected versions can never be published." : v.validation && !v.validation.ok ? "This render failed validation and can't be approved." : `This version is "${v.status.replace("_", " ")}".`}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label>Publish to</Label>
        <div className="mt-2 flex gap-5 text-sm">
          {(["youtube", "instagram"] as const).map((p) => {
            const existing = v.publishingJobs.find((j) => j.platform === p && j.status !== "cancelled");
            return (
              <label key={p} className="flex items-center gap-2">
                <Checkbox disabled={Boolean(existing)} checked={platforms.includes(p) || Boolean(existing)} onCheckedChange={(on) => toggle(p, Boolean(on))} />
                {p === "youtube" ? "YouTube Shorts" : "Instagram Reels"}{existing && <span className="text-xs text-muted-foreground">({existing.status})</span>}
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="flex items-center gap-1.5"><CalendarClock className="size-3.5" /> Schedule (optional — leave empty to publish right away)</Label>
        <Input type="datetime-local" className="max-w-64" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      </div>
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
        Approval is saved with your name and the time. The publishing service re-checks it in the database before every upload.
      </div>
      <Button size="lg" className="bg-emerald-600 text-white hover:bg-emerald-600/90" disabled={approve.isPending || platforms.filter((p) => !v.publishingJobs.some((j) => j.platform === p && j.status !== "cancelled")).length === 0}
        onClick={() => approve.mutate({ platforms: platforms.filter((p) => !v.publishingJobs.some((j) => j.platform === p && j.status !== "cancelled")), scheduledFor: schedule ? new Date(schedule).toISOString() : null }, {
          onSuccess: () => toast.success(schedule ? "Approved and scheduled" : "Approved — queued for publishing"),
          onError: (e) => toast.error(errMsg(e)),
        })}>
        <Check /> {approve.isPending ? "Approving…" : "Approve"}
      </Button>
    </div>
  );
}

function Workspace({ v }: { v: ReviewVersion }) {
  const [dialog, setDialog] = useState<"reject" | "changes" | null>(null);
  const [text, setText] = useState("");
  const reject = useApiMutation((notes: string) => api.post(`/versions/${v.id}/reject`, { notes: notes || undefined }), [["review"], ["publishing"], ["stats"]]);
  const changes = useApiMutation((feedback: string) => api.post(`/versions/${v.id}/request-changes`, { feedback }), [["review"], ["stats"]]);
  const regen = useApiMutation(() => api.post(`/projects/${v.projectId}/regenerate`), [["review"], ["projects"]]);
  const story = v.project.story;
  const val = v.validation;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,380px)_1fr]">
      <div className="flex flex-col gap-3">
        <div className="relative mx-auto aspect-9/16 w-full max-w-[380px] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-primary/10 ring-1 ring-border">
          {v.videoUrl ? <video key={v.id} src={v.videoUrl} poster={v.thumbnailUrl ?? undefined} controls playsInline className="size-full object-contain" /> : <div className="grid size-full place-items-center text-sm text-muted-foreground">No video</div>}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          {val?.ok ? <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="size-3.5" /> {val.width}×{val.height} · {val.fps} fps · validated</span>
            : <span className="flex items-center gap-1 text-red-400"><ShieldAlert className="size-3.5" /> {val?.problems.join("; ") ?? "not validated"}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {v.videoUrl && <a href={v.videoUrl} download={`${story.title}.mp4`}><Button variant="outline" className="w-full"><Download /> Download</Button></a>}
          <Button variant="outline" disabled={regen.isPending || !["ready", "rejected", "changes_requested"].includes(v.status)} onClick={() => regen.mutate(undefined, { onSuccess: () => toast.success("Regeneration queued — a new version will appear here"), onError: (e) => toast.error(errMsg(e)) })}><RefreshCw /> Regenerate</Button>
          <Button variant="outline" disabled={v.status !== "ready"} onClick={() => { setText(""); setDialog("changes"); }}><MessageSquareWarning /> Request changes</Button>
          <Button variant="destructive" disabled={!["ready", "approved", "changes_requested"].includes(v.status)} onClick={() => { setText(""); setDialog("reject"); }}><X /> Reject</Button>
        </div>
      </div>

      <Card className="min-w-0">
        <CardContent className="py-5">
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2"><StatusPill status={v.status} /><Badge variant="outline">{CATEGORY_LABELS[story.category]}</Badge><Badge variant="outline">{LANGUAGE_LABELS[story.language]}</Badge><span className="text-xs text-muted-foreground">v{v.versionNo} · {v.durationSec?.toFixed(1)}s · {new Date(v.createdAt).toLocaleString()}</span></div>
            <h2 className="mt-2 text-xl font-semibold">{story.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground"><span className="text-foreground">Hook:</span> {story.hook}</p>
            <p className="text-sm text-muted-foreground"><span className="text-foreground">Moral:</span> {story.moral}</p>
          </div>
          <Tabs defaultValue="publish">
            <TabsList className="mb-4 flex-wrap">
              <TabsTrigger value="publish">Approve & publish</TabsTrigger>
              <TabsTrigger value="script">Script</TabsTrigger>
              <TabsTrigger value="captions">Title & captions</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="publish"><ApprovePanel v={v} /></TabsContent>
            <TabsContent value="script">
              <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
                {v.script.scenes.map((s) => (
                  <div key={s.index} className="rounded-lg border border-border/60 p-3 text-sm">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scene {s.index + 1}</div>
                    <p className="text-muted-foreground">{s.description}</p>
                    {s.dialogue.map((d, i) => <p key={i} className="mt-1"><span className="font-medium text-primary">{d.speaker}</span> <span className="text-xs text-muted-foreground">({d.emotion})</span>: {d.text}</p>)}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Music: {v.script.musicDirection}</p>
              </div>
            </TabsContent>
            <TabsContent value="captions"><MetadataEditor v={v} /></TabsContent>
            <TabsContent value="history">
              <ul className="flex flex-col gap-2 text-sm">
                {v.approvals.length === 0 && <li className="text-muted-foreground">No decisions yet.</li>}
                {v.approvals.map((a, i) => <li key={i}><StatusPill status={a.decision} /> by {a.user.displayName} · {new Date(a.decidedAt).toLocaleString()}{a.notes ? ` — ${a.notes}` : ""}</li>)}
                {v.publishingJobs.map((j) => <li key={j.id} className="text-muted-foreground">{j.platform}: {j.status}{j.published?.url && <> · <a className="text-primary underline" href={j.published.url} target="_blank" rel="noreferrer">view</a></>}</li>)}
              </ul>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "reject" ? "Reject this reel?" : "Request changes"}</DialogTitle>
            <DialogDescription>{dialog === "reject" ? "It will never be published. The video and its history are kept; you can delete it later." : "Your feedback goes to the story engine, which writes a revised version and renders it again for review."}</DialogDescription>
          </DialogHeader>
          <Textarea rows={4} placeholder={dialog === "reject" ? "Reason (optional)" : "e.g. Make the hook funnier and the squirrel more mischievous; shorter ending"} value={text} onChange={(e) => setText(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            {dialog === "reject"
              ? <Button variant="destructive" disabled={reject.isPending} onClick={() => reject.mutate(text, { onSuccess: () => { toast.success("Rejected — it will never be published"); setDialog(null); }, onError: (e) => toast.error(errMsg(e)) })}>Reject</Button>
              : <Button disabled={changes.isPending || text.trim().length < 5} onClick={() => changes.mutate(text, { onSuccess: () => { toast.success("Revision queued"); setDialog(null); }, onError: (e) => toast.error(errMsg(e)) })}>Send feedback</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ReviewStudioPage() {
  const [filter, setFilter] = useState<string>("ready");
  const review = useReview(filter);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => review.data ?? [], [review.data]);
  const current = list.find((v) => v.id === selected) ?? list[0] ?? null;

  return (
    <>
      <PageHeader title="Review Studio" description="Watch, edit and decide. Nothing is published without your approval." />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map(([k, label]) => <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} onClick={() => { setFilter(k); setSelected(null); }}>{label}</Button>)}
      </div>
      {review.isError && <p className="text-sm text-red-400">{errMsg(review.error)}</p>}
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <div className="flex max-h-[80vh] flex-col gap-2 overflow-y-auto pr-1">
          {review.isPending && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28" />)}
          {review.data?.length === 0 && (
            <Card><CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground"><Clapperboard className="size-8 opacity-50" />Nothing here yet.<span className="text-xs">Generate a reel from the Content Studio.</span></CardContent></Card>
          )}
          {list.map((v) => <ReelCard key={v.id} v={v} active={current?.id === v.id} onClick={() => setSelected(v.id)} />)}
        </div>
        <AnimatePresence mode="wait">
          {current && <motion.div key={current.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}><Workspace v={current} /></motion.div>}
        </AnimatePresence>
      </div>
    </>
  );
}
