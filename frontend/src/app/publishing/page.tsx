"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CalendarDays, ExternalLink, RotateCcw, Send } from "lucide-react";
import { api, errMsg, fmtNum, type PublishingJobRow } from "@/lib/api";
import { useApiMutation, usePublishing } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const LANES: { key: string; title: string; statuses: string[] }[] = [
  { key: "scheduled", title: "Scheduled & queued", statuses: ["scheduled", "queued", "uploading"] },
  { key: "attention", title: "Needs attention", statuses: ["failed", "manual_required"] },
  { key: "published", title: "Published", statuses: ["published"] },
  { key: "cancelled", title: "Cancelled", statuses: ["cancelled"] },
];
const STYLE: Record<string, string> = {
  scheduled: "text-violet-300", queued: "text-sky-300", uploading: "text-sky-300", published: "text-emerald-300", failed: "text-red-300", manual_required: "text-amber-300", cancelled: "text-muted-foreground",
};

function errorText(e: Record<string, unknown> | null) {
  if (!e) return null;
  return String(e.reason ?? e.message ?? e.gate ?? JSON.stringify(e));
}

function JobRow({ j, onManual }: { j: PublishingJobRow; onManual: () => void }) {
  const retry = useApiMutation(() => api.post(`/publishing/${j.id}/retry`), [["publishing"]]);
  const stats = j.published?.analytics[0];
  return (
    <div className="flex gap-3 rounded-lg border border-border/60 p-2.5">
      <div className="aspect-9/16 w-12 shrink-0 overflow-hidden rounded bg-muted">{j.thumbnailUrl && <img src={j.thumbnailUrl} alt="" className="size-full object-cover" />}</div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{j.storyTitle}</span><Badge variant="outline">{j.platform === "youtube" ? "YouTube" : "Instagram"}</Badge><span className={cn("text-xs", STYLE[j.status])}>{j.status.replace("_", " ")}</span></div>
        <div className="text-xs text-muted-foreground">
          v{j.versionNo} · approved by {j.approval.user.displayName} {new Date(j.approval.decidedAt).toLocaleString()}
          {j.scheduledFor && ` · scheduled ${new Date(j.scheduledFor).toLocaleString()}`}
          {j.published && ` · published ${new Date(j.published.publishedAt).toLocaleString()}`}
        </div>
        {errorText(j.lastError) && j.status !== "published" && <p className="mt-1 text-xs text-red-300">{errorText(j.lastError)}</p>}
        {stats && <p className="mt-1 text-xs text-muted-foreground">{fmtNum(stats.views)} views · {fmtNum(stats.likes)} likes · {fmtNum(stats.comments)} comments</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {j.published?.url && <a href={j.published.url} target="_blank" rel="noreferrer noopener"><Button size="sm" variant="ghost"><ExternalLink /> Open</Button></a>}
        {["failed", "manual_required"].includes(j.status) && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(undefined, { onSuccess: () => toast.success("Retry queued (approval is re-checked)"), onError: (e) => toast.error(errMsg(e)) })}><RotateCcw /> Retry</Button>}
        {["failed", "manual_required"].includes(j.status) && <Button size="sm" variant="ghost" onClick={onManual}><Send /> Mark published</Button>}
      </div>
    </div>
  );
}

export default function PublishingPage() {
  const jobs = usePublishing();
  const [manual, setManual] = useState<PublishingJobRow | null>(null);
  const [url, setUrl] = useState("");
  const markManual = useApiMutation((v: { id: string; url: string }) => api.post(`/publishing/${v.id}/manual`, { url: v.url }), [["publishing"]]);
  const upcoming = (jobs.data ?? []).filter((j) => j.scheduledFor && ["scheduled", "queued"].includes(j.status)).sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));

  return (
    <>
      <PageHeader title="Publishing Center" description="Only approved reels appear here. Every upload re-verifies the approval in the database first." />
      {jobs.isError && <p className="text-sm text-red-400">{errMsg(jobs.error)}</p>}
      {upcoming.length > 0 && (
        <Card className="mb-5">
          <CardHeader><CardTitle className="flex items-center gap-2"><CalendarDays className="size-4" /> Publishing calendar</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((j) => (
              <div key={j.id} className="rounded-md border border-border/60 p-2">
                <div className="text-xs text-primary">{new Date(j.scheduledFor!).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                <div className="truncate">{j.storyTitle}</div><div className="text-xs text-muted-foreground">{j.platform}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {LANES.map((lane) => {
          const items = (jobs.data ?? []).filter((j) => lane.statuses.includes(j.status));
          return (
            <Card key={lane.key}>
              <CardHeader><CardTitle className="flex items-center justify-between">{lane.title}<span className="text-sm font-normal text-muted-foreground">{items.length}</span></CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {jobs.isPending && <Skeleton className="h-16" />}
                {jobs.data && items.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
                {items.map((j) => <JobRow key={j.id} j={j} onManual={() => { setUrl(""); setManual(j); }} />)}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Dialog open={manual !== null} onOpenChange={(o) => !o && setManual(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as manually published</DialogTitle>
            <DialogDescription>Download the video from the Review Studio, post it yourself on {manual?.platform}, then paste the post URL. The approval is still verified first.</DialogDescription>
          </DialogHeader>
          <Input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setManual(null)}>Cancel</Button>
            <Button disabled={!/^https?:\/\//.test(url) || markManual.isPending} onClick={() => manual && markManual.mutate({ id: manual.id, url }, { onSuccess: () => { toast.success("Recorded as published"); setManual(null); }, onError: (e) => toast.error(errMsg(e)) })}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
