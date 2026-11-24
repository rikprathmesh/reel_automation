"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ExternalLink, FileVideo, Link2, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { ago, api, errMsg, upload, CATEGORY_LABELS, type Reference } from "@/lib/api";
import { qk, useApiMutation, useReference, useReferences } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { NativeSelect } from "@/components/native-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  extracting: "bg-sky-500/15 text-sky-300",
  extracted: "bg-sky-500/15 text-sky-300",
  analyzing: "bg-violet-500/15 text-violet-300",
  analyzed: "bg-emerald-500/15 text-emerald-300",
  needs_upload: "bg-amber-500/15 text-amber-300",
  failed: "bg-red-500/15 text-red-300",
};
const BUSY = new Set(["queued", "extracting", "extracted", "analyzing"]);

function CategorySelect({ value, onChange, allowAll }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowAll ? "All categories" : "No category"}</option>
      {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </NativeSelect>
  );
}

function AddReferences() {
  const [urls, setUrls] = useState("");
  const [category, setCategory] = useState("rabbit_squirrel_adventure");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const add = useApiMutation((v: { urls: string[]; category?: string }) => api.post("/references", v), [qk.references]);
  const refresh = useApiMutation(async () => undefined, [qk.references]);

  const submit = () => {
    const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!list.length) return;
    add.mutate({ urls: list, category: category || undefined }, {
      onSuccess: () => { toast.success(`${list.length} reference${list.length > 1 ? "s" : ""} queued for analysis`); setUrls(""); },
      onError: (e) => toast.error(errMsg(e)),
    });
  };
  const onFile = async (f: File) => {
    setUploading(true);
    try {
      await upload("/references/upload", f, { category: category || undefined, title: f.name });
      toast.success("Video uploaded — queued for analysis");
      refresh.mutate(undefined);
    } catch (e) { toast.error(errMsg(e)); } finally { setUploading(false); }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Add references</CardTitle>
        <CardDescription>Paste Instagram / YouTube links (one per line), or upload the video file directly. References are studied for craft only, never copied.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-[1fr_260px]">
        <Textarea rows={3} placeholder={"https://www.instagram.com/reel/…\nhttps://www.youtube.com/shorts/…"} value={urls} onChange={(e) => setUrls(e.target.value)} />
        <div className="flex flex-col gap-2">
          <CategorySelect value={category} onChange={setCategory} />
          <Button onClick={submit} disabled={add.isPending || !urls.trim()}><Link2 /> {add.isPending ? "Adding…" : "Analyze URLs"}</Button>
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onFile(f); }} />
          <Button variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />} {uploading ? "Uploading…" : "Upload video (MP4/MOV/WebM)"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReferenceCard({ r, onOpen, i }: { r: Reference; onOpen: () => void; i: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useApiMutation(async () => undefined, [qk.references]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); refresh.mutate(undefined); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const failed = r.status === "failed" || r.status === "needs_upload";

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-3 py-4">
          <div className="flex items-start gap-3">
            <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-muted/50">
              {r.thumbnailUrl ? <img src={r.thumbnailUrl} alt="" className="size-full object-cover" /> : <FileVideo className="size-6 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[r.status])}>
                  {BUSY.has(r.status) && <Loader2 className="size-3 animate-spin" />}{r.status.replace("_", " ")}
                </span>
                <Badge variant="outline">{r.platform}</Badge>
                {r.source === "upload" && <Badge variant="outline">uploaded</Badge>}
              </div>
              <div className="mt-1 truncate text-sm font-medium">{r.title ?? r.url ?? "Uploaded video"}</div>
              <div className="text-xs text-muted-foreground">{r.category ? CATEGORY_LABELS[r.category] : "No category"} · {ago(r.createdAt)}</div>
            </div>
          </div>
          {r.analysis?.summary && <p className="line-clamp-3 text-xs text-muted-foreground">{r.analysis.summary}</p>}
          {failed && r.error && <p className="rounded-md bg-red-500/10 p-2 text-xs text-red-300">{r.error}</p>}
          {r.status === "queued" && <p className="text-xs text-muted-foreground">Waiting for the reference service (built in Phase 4).</p>}
          <div className="mt-auto flex flex-wrap gap-1.5">
            {r.status === "analyzed" && <Button size="sm" variant="secondary" onClick={onOpen}>View analysis</Button>}
            {r.url && <a href={r.url} target="_blank" rel="noreferrer noopener" className="inline-flex"><Button size="sm" variant="ghost"><ExternalLink /> Open</Button></a>}
            {failed && (
              <>
                <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => {
                  const f = e.target.files?.[0]; e.target.value = "";
                  if (f) void act(() => upload("/references/upload", f, { referenceId: r.id, category: r.category ?? undefined }), "Video uploaded — re-analyzing");
                }} />
                <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload /> Upload the video instead</Button>
              </>
            )}
            {!BUSY.has(r.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.post(`/references/${r.id}/analyze`), "Re-analysis queued")}><RefreshCw /> Re-run</Button>}
            <Button size="sm" variant="ghost" className="text-red-400" disabled={busy} aria-label="Delete reference"
              onClick={() => { if (confirm("Remove this reference?")) void act(() => api.del(`/references/${r.id}`), "Reference removed"); }}><Trash2 /></Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3><div className="text-sm">{children}</div></div>;
}
const show = (v: unknown) => (typeof v === "string" ? v : <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>);

function AnalysisDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const ref = useReference(id);
  const a = ref.data?.analysis;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{ref.data?.title ?? "Reference analysis"}</DialogTitle></DialogHeader>
        {ref.isPending && <Skeleton className="h-60" />}
        {ref.data && (
          <div className="flex flex-col gap-4">
            {ref.data.videoUrl && <video src={ref.data.videoUrl} controls className="max-h-80 rounded-lg bg-black" />}
            {ref.data.caption && <Section title="Caption">{ref.data.caption}</Section>}
            {ref.data.transcript && <Section title="Transcript"><p className="max-h-40 overflow-y-auto text-muted-foreground">{ref.data.transcript}</p></Section>}
            {a && (
              <>
                <Section title="Summary">{a.summary}</Section>
                <Section title="Hook">{show(a.hook)}</Section>
                <Section title="Story structure">{show(a.structure)}</Section>
                <Section title="Pacing">{show(a.pacing)}</Section>
                <Section title="Transitions">{show(a.transitions)}</Section>
                <Section title="Visual style">{show(a.visualStyle)}</Section>
                <Section title="Characters">{show(a.characterTraits)}</Section>
                <Section title="Voice & narration">{show(a.narration)}</Section>
                <Section title="Emotional arc">{a.emotionalArc}</Section>
                {a.doNotCopy?.length ? <Section title="Never copy">{a.doNotCopy.join(" · ")}</Section> : null}
                <p className="text-xs text-muted-foreground">Analyzed with {a.model}</p>
              </>
            )}
            {ref.data.stories?.length ? <Section title="Stories inspired by this reference">{ref.data.stories.map((s) => s.title).join(", ")}</Section> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ReferencesPage() {
  const refs = useReferences();
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = (refs.data ?? []).filter((r) => !category || r.category === category);

  return (
    <>
      <PageHeader title="Reference Library" description="Reference reels and what makes them work." actions={<div className="w-56"><CategorySelect value={category} onChange={setCategory} allowAll /></div>} />
      <AddReferences />
      {refs.isError && <p className="text-sm text-red-400">{errMsg(refs.error)}</p>}
      {refs.isPending && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40" />)}</div>}
      {refs.data && list.length === 0 && <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No references{category ? " in this category" : ""} yet.</CardContent></Card>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((r, i) => <ReferenceCard key={r.id} r={r} i={i} onOpen={() => setOpen(r.id)} />)}
      </div>
      {open && <AnalysisDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
