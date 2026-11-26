"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, BookMarked, CheckCircle2, Clapperboard, Cpu, Film, History, ListRestart, Loader2, Minimize2, Maximize2, Pencil, RefreshCw, Save, Sparkles, Trash2, Upload, Users, Wand2 } from "lucide-react";
import {
  api, ago, errMsg, draftOf, upload, CATEGORY_LABELS, AGE_GROUP_LABELS, STORY_SOURCE_LABELS,
  type FlowPack, type ModelCaps, type PromptStudioPayload, type PromptStudioScene, type PromptTemplate, type ScenePrompt, type RenderedPrompt,
} from "@/lib/api";
import { useApiMutation, useStories } from "@/lib/queries";
import { PageHeader } from "@/components/page-header";
import { NativeSelect } from "@/components/native-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const ORIGIN_LABEL: Record<string, string> = {
  ai: "AI", ai_improved: "AI improved", ai_shortened: "AI shortened", ai_expanded: "AI expanded", ai_instructed: "AI (instruction)",
  manual: "manual edit", model_switch: "model switch", template: "template", restored: "restored",
};

function scoreTone(score: number | null | undefined) {
  if (score == null) return "border-border text-muted-foreground";
  if (score >= 85) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (score >= 70) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
}

const usePromptStudio = (storyId: string | null) =>
  useQuery({
    queryKey: ["prompts", "story", storyId],
    queryFn: () => api.get<PromptStudioPayload>(`/prompts/story/${storyId}`),
    enabled: Boolean(storyId),
    // jobs finish in the background; live events refresh too, polling is the fallback
    refetchInterval: (q) => (q.state.data?.pending.length ? 10_000 : false),
  });
const useModels = () => useQuery({ queryKey: ["prompts", "models"], queryFn: () => api.get<ModelCaps[]>("/prompts/models"), staleTime: 60_000 });
const useTemplates = () => useQuery({ queryKey: ["prompts", "templates"], queryFn: () => api.get<PromptTemplate[]>("/prompts/templates") });

function PromptText({ label, text, empty = "—" }: { label: string; text: string; empty?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        {text && <button type="button" className="hover:text-foreground" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}>Copy</button>}
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed">{text || empty}</pre>
    </div>
  );
}

function Rendered({ r, note }: { r: RenderedPrompt | ScenePrompt; note?: string }) {
  const routed = "routed" in r ? r.routed : r.params?.routed;
  return (
    <div className="flex flex-col gap-3">
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <PromptText label="Prompt" text={r.positive} empty="(this model takes no text prompt)" />
      <PromptText label="Negative prompt" text={r.negative} empty="(not supported by this model)" />
      {r.dropped.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
          <div className="mb-1 font-medium text-amber-700 dark:text-amber-300">Not sent: this model can&apos;t follow</div>
          <ul className="list-disc pl-4 text-muted-foreground">{r.dropped.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      {routed && routed.length > 0 && <p className="text-xs text-muted-foreground">Handled by other stages: {routed.join("; ")}</p>}
    </div>
  );
}

function Sections({ p }: { p: ScenePrompt }) {
  const s = p.spec;
  const row = (k: string, v: string | undefined) => v ? <div className="grid grid-cols-[110px_1fr] gap-2 py-1"><span className="text-muted-foreground">{k}</span><span>{v}</span></div> : null;
  return (
    <div className="divide-y divide-border/60 text-xs">
      <div className="py-1.5"><div className="mb-1 font-medium">Key moment</div>{s.keyMoment}</div>
      {s.characters.map((c) => (
        <div key={c.id} className="py-1.5">
          <div className="mb-1 font-medium">A · {c.name} — identity (locked)</div>
          <p className="mb-1 text-muted-foreground">{c.identity}</p>
          {row("C · action", c.beat.action)}{row("E · movement", c.beat.movements.join("; "))}{row("interaction", c.beat.interaction)}
          {row("start", c.beat.startPosition)}{row("end", c.beat.endPosition)}
          {row("D · face", [c.beat.expression, c.beat.eyes && `eyes ${c.beat.eyes}`, c.beat.mouth && `mouth ${c.beat.mouth}`, c.beat.head].filter(Boolean).join("; "))}
          {row("voice", c.voice ?? "narrator voice")}
        </div>
      ))}
      <div className="py-1.5"><div className="mb-1 font-medium">B · Environment</div>
        {row("location", s.environment.location)}{row("background", s.environment.background)}{row("time / weather", `${s.environment.timeOfDay}; ${s.environment.weather}`)}
        {row("objects", s.environment.objects.join("; "))}{row("details", s.environment.details.join("; "))}</div>
      <div className="py-1.5"><div className="mb-1 font-medium">F · Camera</div>
        {row("shot", `${s.camera.shot.replaceAll("_", " ")}, ${s.camera.angle}`)}{row("movement", `${s.camera.movement.replaceAll("_", " ")} — ${s.camera.movementDetail}`)}{row("focus", s.camera.focus)}</div>
      <div className="py-1.5"><div className="mb-1 font-medium">G · Look</div>
        {row("lighting", s.visual.lighting)}{row("atmosphere", s.visual.atmosphere)}{row("colour", s.visual.colorGrade)}{row("effects", s.visual.effects.join("; "))}</div>
      <div className="py-1.5"><div className="mb-1 font-medium">H · Audio</div>
        {s.audio.dialogue.map((d, i) => <div key={i} className="py-0.5"><span className="text-muted-foreground">{d.speaker} ({d.emotion}):</span> {d.text}</div>)}
        {row("sfx", s.audio.sfx.join("; "))}{row("ambience", s.audio.ambience)}{row("lip-sync", s.audio.lipSync ? "wanted (not supported by local models)" : "not needed")}</div>
      <div className="py-1.5"><div className="mb-1 font-medium">I · Continuity</div>
        {row("from previous", s.continuity.fromPrevious || "first scene")}{row("to next", s.continuity.toNext || "last scene")}{row("keep", s.continuity.props)}</div>
      <div className="py-1.5"><div className="mb-1 font-medium">J · Negatives</div><p className="text-muted-foreground">{s.negative.join(", ")}</p></div>
    </div>
  );
}

function Quality({ p }: { p: ScenePrompt }) {
  const e = p.evaluation;
  if (!e) return <p className="text-xs text-muted-foreground">Not evaluated.</p>;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="text-muted-foreground">Checks that each instruction is present and specific. It can&apos;t judge artistic quality: watch the generated clip for that.</p>
      {e.checks.map((c) => (
        <div key={c.id} className="flex items-start gap-2">
          {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", c.severity === "error" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")} />}
          <div><span className="font-medium">{c.label}</span> <span className="text-muted-foreground">— {c.detail}</span></div>
        </div>
      ))}
      {e.notes.length > 0 && <div className="mt-1 rounded-md border bg-muted/40 p-2">{e.notes.map((n) => <p key={n}>{n}</p>)}</div>}
    </div>
  );
}

function SceneCard({ scene, models, templates, busy }: { scene: PromptStudioScene; models: ModelCaps[]; templates: PromptTemplate[]; busy: boolean }) {
  const p = scene.prompt;
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [sections, setSections] = useState("");
  const [finalText, setFinalText] = useState("");
  const [finalNeg, setFinalNeg] = useState("");
  const [tplName, setTplName] = useState("");
  const keys = [["prompts"]] as const;
  const generate = useApiMutation((targetModel?: string) => api.post(`/prompts/scene/${scene.id}/generate`, { targetModel }), keys);
  const transform = useApiMutation((b: { op: string; instruction?: string }) => api.post(`/prompts/${p!.id}/transform`, b), keys);
  const switchModel = useApiMutation((targetModel: string) => api.post(`/prompts/${p!.id}/model`, { targetModel }), keys);
  const edit = useApiMutation((b: object) => api.put(`/prompts/${p!.id}`, b), keys);
  const restore = useApiMutation((id: string) => api.post(`/prompts/${id}/restore`), keys);
  const saveTpl = useApiMutation((name: string) => api.post("/prompts/templates", { promptId: p!.id, name }), keys);
  const applyTpl = useApiMutation((templateId: string) => api.post(`/prompts/${p!.id}/apply-template`, { templateId }), keys);
  const queued = (r: unknown) => toast.success((r as { duplicate?: boolean }).duplicate ? "Already queued for this scene" : "Queued: the local LLM rewrites this scene's prompt (2-5 min)");
  const fail = (e: unknown) => toast.error(errMsg(e));
  const model = models.find((m) => m.id === p?.targetModel);
  const working = busy || generate.isPending || transform.isPending;

  const openEdit = () => {
    if (!p) return;
    setSections(JSON.stringify(draftOf(p.spec), null, 2));
    setFinalText(p.spec.override?.positive ?? "");
    setFinalNeg(p.spec.override?.negative ?? "");
    setEditing(true);
  };
  const saveEdit = () => {
    let draft: unknown;
    try { draft = JSON.parse(sections); } catch { toast.error("Sections are not valid JSON"); return; }
    edit.mutate({ draft, positive: finalText, negative: finalNeg.trim() ? finalNeg : null }, { onSuccess: () => { setEditing(false); toast.success("Saved as a new version"); }, onError: fail });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Scene {scene.index + 1}{scene.title ? ` · ${scene.title}` : ""}</CardTitle>
            <CardDescription>{scene.location || "—"} · ~{Math.round(scene.durationHint)} s{scene.events.length ? ` · story events ${scene.events.join(", ")}` : ""}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {working && <span className="flex items-center gap-1 text-sky-600 dark:text-sky-300"><Loader2 className="size-3.5 animate-spin" /> queued / writing</span>}
            {p && <span className={cn("rounded-md border px-2 py-0.5 font-medium", scoreTone(p.score))}>quality {p.score ?? "—"}</span>}
            {p && <Badge variant="outline">v{p.version} · {ORIGIN_LABEL[p.origin] ?? p.origin}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,300px)_1fr]">
        <div className="flex flex-col gap-3 text-sm">
          <p>{scene.description}</p>
          <div className="flex flex-wrap gap-2">
            {scene.characters.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs">
                {c.imageUrl ? <img src={c.imageUrl} alt="" className="size-6 rounded-full object-cover" /> : <span className="grid size-6 place-items-center rounded-full bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300" title="No master reference image yet">!</span>}
                {c.name}
              </div>
            ))}
          </div>
          <div className="rounded-md border bg-muted/30 p-2 text-xs">
            {scene.dialogue.map((d, i) => <p key={i} className="py-0.5"><span className="text-muted-foreground">{d.speaker}:</span> {d.text}</p>)}
          </div>
        </div>

        {!p ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p>No structured prompt yet. Production would fall back to the story&apos;s one-line visual prompt.</p>
            <Button size="sm" disabled={working} onClick={() => generate.mutate(undefined, { onSuccess: queued, onError: fail })}><Sparkles /> Generate prompt</Button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <Tabs defaultValue="video">
              <TabsList>
                <TabsTrigger value="video">{model?.output === "image" ? "Image" : "Video"} prompt</TabsTrigger>
                <TabsTrigger value="keyframe">Keyframe</TabsTrigger>
                <TabsTrigger value="sections">Sections</TabsTrigger>
                <TabsTrigger value="quality">Quality</TabsTrigger>
                <TabsTrigger value="history">History ({scene.history.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="video"><Rendered r={p} note={`${model?.label ?? p.targetModel}${model && !model.installed ? " — not installed on this machine yet" : ""}${p.spec.override?.positive ? " · manual text override active" : ""}`} /></TabsContent>
              <TabsContent value="keyframe">{p.keyframe ? <Rendered r={p.keyframe} note="Still image for this scene (SD 1.5 + the characters' reference images), rendered from the same sections. It is the first frame for image-to-video models." /> : null}</TabsContent>
              <TabsContent value="sections"><Sections p={p} /></TabsContent>
              <TabsContent value="quality"><Quality p={p} /></TabsContent>
              <TabsContent value="history">
                <div className="divide-y divide-border/60 text-xs">
                  {scene.history.map((h) => (
                    <div key={h.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span>v{h.version} · {ORIGIN_LABEL[h.origin] ?? h.origin}{h.instruction ? ` (“${h.instruction.slice(0, 60)}”)` : ""} · {h.targetModel} · quality {h.score ?? "—"} · {ago(h.createdAt)}</span>
                      {h.isCurrent ? <Badge variant="secondary">current</Badge> : <Button size="sm" variant="ghost" disabled={restore.isPending} onClick={() => restore.mutate(h.id, { onSuccess: () => toast.success(`v${h.version} restored as a new version`), onError: fail })}><ListRestart /> Restore</Button>}
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" variant="outline" disabled={working} onClick={() => generate.mutate(p.targetModel, { onSuccess: queued, onError: fail })}><RefreshCw /> Regenerate</Button>
              <Button size="sm" variant="outline" disabled={working} onClick={() => transform.mutate({ op: "improve" }, { onSuccess: queued, onError: fail })}><Wand2 /> Improve</Button>
              <Button size="sm" variant="outline" disabled={working} onClick={() => transform.mutate({ op: "shorten" }, { onSuccess: queued, onError: fail })}><Minimize2 /> Shorten</Button>
              <Button size="sm" variant="outline" disabled={working} onClick={() => transform.mutate({ op: "expand" }, { onSuccess: queued, onError: fail })}><Maximize2 /> Expand</Button>
              <Button size="sm" variant="outline" onClick={openEdit}><Pencil /> Edit</Button>
              <NativeSelect className="h-8 w-auto text-xs" aria-label="Target model" value={p.targetModel} disabled={switchModel.isPending}
                onChange={(e) => switchModel.mutate(e.target.value, { onSuccess: () => toast.success("Re-rendered for the new model (story unchanged)"), onError: fail })}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.installed ? "" : " (not installed)"}</option>)}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-8 min-w-60 flex-1 text-xs" placeholder="Change camera, action or look, e.g. “slow tracking shot from behind, Sheru jumps at the end”" value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={1000} />
              <Button size="sm" disabled={working || instruction.trim().length < 3} onClick={() => transform.mutate({ op: "instruct", instruction: instruction.trim() }, { onSuccess: (r) => { setInstruction(""); queued(r); }, onError: fail })}><Sparkles /> Apply with AI</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Input className="h-8 w-52 text-xs" placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={80} />
              <Button size="sm" variant="ghost" disabled={tplName.trim().length < 2 || saveTpl.isPending} onClick={() => saveTpl.mutate(tplName.trim(), { onSuccess: () => { setTplName(""); toast.success("Template saved (camera, look and negatives only)"); }, onError: fail })}><Save /> Save as template</Button>
              {templates.length > 0 && (
                <NativeSelect className="h-8 w-auto text-xs" aria-label="Apply template" value="" onChange={(e) => e.target.value && applyTpl.mutate(e.target.value, { onSuccess: () => toast.success("Template applied as a new version"), onError: fail })}>
                  <option value="">Apply template…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </NativeSelect>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit scene {scene.index + 1} prompt</DialogTitle>
            <DialogDescription>Edits create a new version. Character identity, style and dialogue stay locked; the story itself is never changed.</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[65vh] flex-col gap-3 overflow-auto">
            <label className="text-xs font-medium text-muted-foreground">Sections (JSON)
              <Textarea className="mt-1 font-mono text-xs" rows={14} value={sections} onChange={(e) => setSections(e.target.value)} />
            </label>
            <label className="text-xs font-medium text-muted-foreground">Final prompt override (optional: replaces the generated text for this model; leave empty to use the sections)
              <Textarea className="mt-1 font-mono text-xs" rows={4} value={finalText} onChange={(e) => setFinalText(e.target.value)} />
            </label>
            <label className="text-xs font-medium text-muted-foreground">Negative prompt override (optional)
              <Textarea className="mt-1 font-mono text-xs" rows={2} value={finalNeg} onChange={(e) => setFinalNeg(e.target.value)} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            <Button disabled={edit.isPending} onClick={saveEdit}><Save /> Save version</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function BibleView({ d }: { d: PromptStudioPayload }) {
  const b = d.story.understanding;
  if (!b) return <Card><CardContent className="py-8 text-sm text-muted-foreground">No story bible yet. Stories made before the understanding engine have none; generating prompts still works from the narration.</CardContent></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-base">{b.title}</CardTitle><CardDescription>{b.logline}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {b.sourceNotes && <p className="rounded-md border bg-muted/40 p-2 text-xs"><span className="font-medium">Source ({b.sourceType.replaceAll("_", " ")}):</span> {b.sourceNotes}</p>}
          <p><span className="text-muted-foreground">Beginning:</span> {b.beginning}</p>
          <p><span className="text-muted-foreground">Middle:</span> {b.middle}</p>
          <p><span className="text-muted-foreground">Ending:</span> {b.ending}</p>
          <p><span className="text-muted-foreground">Moral:</span> {b.moral}</p>
          {b.conflicts.length > 0 && <p><span className="text-muted-foreground">Conflicts:</span> {b.conflicts.join("; ")}</p>}
          <p><span className="text-muted-foreground">Emotional arc:</span> {b.emotions.join(" → ")}</p>
          {d.story.sourceText && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Creator&apos;s original text</summary><p className="mt-1 whitespace-pre-wrap">{d.story.sourceText}</p></details>}
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Events in order</CardTitle></CardHeader>
        <CardContent><ol className="flex flex-col gap-1.5 text-sm">{b.events.map((e) => <li key={e.order}><span className="text-muted-foreground">{e.order}.</span> {e.summary} <span className="text-xs text-muted-foreground">({e.location}; {e.characters.join(", ")}; {e.emotion})</span></li>)}</ol></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Characters</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">{b.characters.map((c) => <div key={c.name}><span className="font-medium">{c.name}</span> <span className="text-muted-foreground">({c.role}, {c.species})</span> — {c.personality}. <span className="text-muted-foreground">{c.appearance}</span>{c.relationships.length > 0 && <span className="text-xs text-muted-foreground"> · {c.relationships.map((r) => `${r.relation} of ${r.to}`).join(", ")}</span>}</div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Locations &amp; objects</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {b.locations.map((l) => <div key={l.name}><span className="font-medium">{l.name}</span> <span className="text-muted-foreground">({l.timeOfDay})</span> — {l.description}</div>)}
          {b.objects.map((o) => <div key={o.name} className="text-xs"><span className="font-medium">{o.name}</span> — {o.description} <span className="text-muted-foreground">({o.importance})</span></div>)}
        </CardContent></Card>
    </div>
  );
}

function CharactersView({ d }: { d: PromptStudioPayload }) {
  const profile = useApiMutation((v: { id: string; force: boolean }) => api.post(`/prompts/character/${v.id}/profile`, { force: v.force, storyId: d.story.id }), [["prompts"]]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {d.characters.map((c) => {
        const pending = d.pending.some((j) => j.characterId === c.id);
        return (
          <Card key={c.id}>
            <CardHeader className="flex flex-row items-start gap-3">
              {c.imageUrl ? <img src={c.imageUrl} alt="" className="size-20 rounded-lg object-cover" /> : <div className="grid size-20 place-items-center rounded-lg bg-amber-500/10 p-1 text-center text-[11px] text-amber-700 dark:text-amber-300">no master image yet</div>}
              <div className="min-w-0">
                <CardTitle className="text-base">{c.name}</CardTitle>
                <CardDescription>{c.species || "—"} · {c.personality}</CardDescription>
                <p className="mt-1 text-xs"><span className="text-muted-foreground">Identity (restated in every scene):</span> {c.identity}</p>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {c.referencePrompts.length === 0 && <p className="text-xs text-muted-foreground">No permanent profile / reference prompts yet.</p>}
              {c.referencePrompts.map((r) => (
                <details key={r.id} className="text-xs"><summary className="cursor-pointer font-medium capitalize">{r.view.replaceAll("_", " ")} view</summary>
                  <div className="mt-1.5"><PromptText label="Prompt" text={r.positive} /><div className="mt-2"><PromptText label="Negative" text={r.negative} /></div></div></details>
              ))}
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={pending || profile.isPending} onClick={() => profile.mutate({ id: c.id, force: false }, { onSuccess: () => toast.success("Queued"), onError: (e) => toast.error(errMsg(e)) })}><Users /> {c.referencePrompts.length ? "Refresh reference prompts" : "Write profile"}</Button>
                {c.visualProfile && <Button size="sm" variant="ghost" disabled={pending || profile.isPending} onClick={() => profile.mutate({ id: c.id, force: true }, { onSuccess: () => toast.success("Queued: profile rewritten (identity text is kept)"), onError: (e) => toast.error(errMsg(e)) })}>Rewrite profile</Button>}
                {pending && <span className="flex items-center gap-1 text-xs text-sky-600 dark:text-sky-300"><Loader2 className="size-3.5 animate-spin" /> queued</span>}
              </div>
              <p className="text-[11px] text-muted-foreground">Generating the multi-view reference images from these prompts is Phase 3. Upload or set the master image in Character Studio.</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Flow-assisted production: copy prompts into Google Flow, upload the clips, ReelForge assembles the reel. */
function FlowView({ storyId }: { storyId: string }) {
  const pack = useQuery({ queryKey: ["prompts", "flow", storyId], queryFn: () => api.get<FlowPack>(`/flow/story/${storyId}`) });
  const [busy, setBusy] = useState<string | null>(null);
  const remove = useApiMutation((sceneId: string) => api.del(`/flow/scene/${sceneId}/clip`), [["prompts"]]);
  const assemble = useApiMutation(() => api.post<{ projectId: string; flowClips: number; localScenes: number }>(`/flow/story/${storyId}/assemble`), [["prompts"], ["projects"], ["jobs"]]);
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success("Copied — paste it into Google Flow"));
  const onFile = async (sceneId: string, file: File | undefined) => {
    if (!file) return;
    setBusy(sceneId);
    try {
      const r = await upload<{ duration: number; hasAudio: boolean }>(`/flow/scene/${sceneId}/clip`, file);
      toast.success(`Clip saved: ${r.duration.toFixed(1)} s${r.hasAudio ? " with sound" : " — NO sound in this clip"}`);
      await pack.refetch();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  if (pack.isPending) return <Skeleton className="h-60" />;
  if (pack.isError) return <p className="text-sm text-red-600 dark:text-red-400">{errMsg(pack.error)}</p>;
  const p = pack.data!;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Make the clips in Google Flow, ReelForge does the rest</CardTitle>
          <CardDescription>
            1. In Flow, create each character&apos;s image once (prompt below) or upload its picture, and add it as an <em>ingredient</em>.
            2. For every scene: copy the prompt, generate a vertical clip in Flow, download it, upload it here.
            3. Press <strong>Assemble reel</strong>: clips in order with their own Veo voices and sound, music under them, subtitles, checks → Review Studio.
            Scenes without a clip are made locally (still picture + local voice).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant="outline">{p.clipsUploaded} of {p.scenes.length} clips uploaded</Badge>
          <Button disabled={!p.clipsUploaded || assemble.isPending} onClick={() => assemble.mutate(undefined, { onSuccess: (r) => toast.success(`Assembling: ${r.flowClips} Flow clip(s)${r.localScenes ? ` + ${r.localScenes} local scene(s)` : ""}. Follow it in Generation Progress; it appears in Review Studio.`), onError: (e) => toast.error(errMsg(e)) })}>
            {assemble.isPending ? <Loader2 className="animate-spin" /> : <Film />} Assemble reel
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {p.characters.map((c) => (
          <Card key={c.id}>
            <CardHeader className="flex flex-row items-start gap-3">
              {c.imageUrl ? <a href={c.imageUrl} download title="Download to use as an ingredient in Flow"><img src={c.imageUrl} alt="" className="size-20 rounded-lg object-cover" /></a> : <div className="grid size-20 place-items-center rounded-lg bg-muted text-center text-[11px] text-muted-foreground">make in Flow</div>}
              <div className="min-w-0"><CardTitle className="text-base">{c.name}</CardTitle><CardDescription className="text-xs">{c.identity}</CardDescription></div>
            </CardHeader>
            <CardContent><PromptText label="Character image prompt for Flow" text={c.flowPrompt} /></CardContent>
          </Card>
        ))}
      </div>

      {p.scenes.map((s) => (
        <Card key={s.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><CardTitle className="text-base">Scene {s.index + 1}{s.title ? ` · ${s.title}` : ""}</CardTitle><CardDescription>{s.description}</CardDescription></div>
              {s.clip ? <Badge className="gap-1"><CheckCircle2 className="size-3" /> clip {s.clip.duration?.toFixed(1)} s{s.clip.hasAudio === false ? " · no sound" : ""}</Badge> : <Badge variant="outline">no clip yet</Badge>}
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-[1fr_minmax(0,220px)]">
            <div className="flex min-w-0 flex-col gap-2">
              {s.veoPrompt ? (
                <>
                  <PromptText label="Veo prompt (paste into Flow)" text={s.veoPrompt} />
                  <Button size="sm" variant="outline" className="self-start" onClick={() => copy(s.veoPrompt!)}>Copy prompt</Button>
                </>
              ) : <p className="text-sm text-muted-foreground">No scene prompt yet — generate prompts on the Scenes tab first.</p>}
              {s.notes.length > 0 && <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-300">{s.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </div>
            <div className="flex flex-col gap-2">
              {s.clip && <video src={s.clip.url} controls playsInline className="aspect-9/16 w-full rounded-lg bg-black object-contain" />}
              <label className={cn("flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-muted/50", busy === s.id && "pointer-events-none opacity-60")}>
                {busy === s.id ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {s.clip ? "Replace clip" : "Upload Flow clip"}
                <input type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={(e) => void onFile(s.id, e.target.files?.[0])} />
              </label>
              {s.clip && <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(s.id, { onSuccess: () => toast.success("Clip removed: this scene will be made locally"), onError: (e) => toast.error(errMsg(e)) })}><Trash2 /> Remove clip</Button>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ModelsView({ models }: { models: ModelCaps[] }) {
  const yes = (b: boolean) => (b ? "yes" : "—");
  return (
    <Card><CardContent className="overflow-x-auto py-3">
      <table className="w-full min-w-[860px] text-left text-xs">
        <thead className="text-muted-foreground"><tr>{["Model", "Real animation", "Installed", "Text→video", "Image→video", "References", "Camera", "Negative", "Max clip", "GPU", "Licence"].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-border/60">
          {models.map((m) => (
            <tr key={m.id} className="align-top">
              <td className="px-2 py-2"><div className="font-medium">{m.label}</div><div className="max-w-72 text-muted-foreground">{m.notes}</div></td>
              <td className="px-2 py-2">{m.isAiAnimation ? "yes" : <span className="text-amber-700 dark:text-amber-300">no</span>}</td>
              <td className="px-2 py-2">{m.installed ? <span className="text-emerald-700 dark:text-emerald-300">yes</span> : "no"}</td>
              <td className="px-2 py-2">{yes(m.textToVideo)}</td><td className="px-2 py-2">{yes(m.imageToVideo)}</td>
              <td className="px-2 py-2">{m.referenceImages.replaceAll("_", " ")}</td><td className="px-2 py-2">{m.camera.replaceAll("_", " ")}</td>
              <td className="px-2 py-2">{yes(m.negativePrompt)}</td><td className="px-2 py-2">{m.maxClipSec ? `${m.maxClipSec} s @ ${m.fps} fps` : "still"}</td>
              <td className="px-2 py-2">{m.requiresGpu ? "NVIDIA" : "CPU ok"}</td><td className="px-2 py-2">{m.license}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </CardContent></Card>
  );
}

function Studio() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const stories = useStories();
  const storyId = params.get("story") ?? stories.data?.[0]?.id ?? null;
  const studio = usePromptStudio(storyId);
  const models = useModels();
  const templates = useTemplates();
  const [genModel, setGenModel] = useState("");
  const generateAll = useApiMutation((b: object) => api.post(`/prompts/story/${storyId}/generate`, b), [["prompts"]]);
  const d = studio.data;
  const scored = d?.scenes.filter((s) => s.prompt?.score != null) ?? [];
  const avg = scored.length ? Math.round(scored.reduce((n, s) => n + (s.prompt!.score ?? 0), 0) / scored.length) : null;
  const storyJob = d?.pending.some((j) => j.name === "prompts-story");

  return (
    <>
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="flex min-w-72 flex-1 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Story</span>
            <NativeSelect value={storyId ?? ""} onChange={(e) => router.replace(`${pathname}?story=${e.target.value}`)}>
              {stories.data?.map((s) => <option key={s.id} value={s.id}>{s.title}{s.episodeNo && s.episodeNo > 1 ? ` (ep. ${s.episodeNo})` : ""}</option>)}
            </NativeSelect></div>
          <div className="flex w-72 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Target model for new prompts</span>
            <NativeSelect value={genModel} onChange={(e) => setGenModel(e.target.value)}>
              <option value="">Keep each scene&apos;s model (default: AnimateDiff)</option>
              {models.data?.map((m) => <option key={m.id} value={m.id}>{m.label}{m.installed ? "" : " (not installed)"}</option>)}
            </NativeSelect></div>
          <Button disabled={!storyId || generateAll.isPending || storyJob} onClick={() => generateAll.mutate({ targetModel: genModel || undefined, onlyMissing: false }, { onSuccess: (r) => toast.success((r as { duplicate?: boolean }).duplicate ? "Already queued" : "Queued: every scene's prompt is rewritten in story order (about 2-5 min per scene)"), onError: (e) => toast.error(errMsg(e)) })}>
            {storyJob ? <Loader2 className="animate-spin" /> : <Sparkles />} {d?.scenes.some((s) => s.prompt) ? "Regenerate all prompts" : "Generate all prompts"}
          </Button>
          {d && (
            <p className="w-full text-xs text-muted-foreground">
              {[CATEGORY_LABELS[d.story.category] ?? d.story.category, d.story.ageGroup && AGE_GROUP_LABELS[d.story.ageGroup], d.story.sourceMode && STORY_SOURCE_LABELS[d.story.sourceMode], `${d.scenes.length} scenes`, `${d.scenes.filter((s) => s.prompt).length} with prompts`, avg != null && `average quality ${avg}`].filter(Boolean).join(" · ")}
              {d.pending.length > 0 && <span className="ml-2 text-sky-600 dark:text-sky-300">· {d.pending.length} prompt job(s) queued or running (heavy jobs run one at a time)</span>}
            </p>
          )}
        </CardContent>
      </Card>

      {!storyId && !stories.isPending && <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No stories yet. Create one in the Content Studio.</CardContent></Card>}
      {studio.isPending && storyId && <Skeleton className="h-96" />}
      {studio.isError && <p className="text-sm text-red-600 dark:text-red-400">{errMsg(studio.error)}</p>}
      {d && (
        <Tabs defaultValue="scenes">
          <TabsList className="mb-4">
            <TabsTrigger value="scenes"><Clapperboard /> Scenes</TabsTrigger>
            <TabsTrigger value="bible"><BookMarked /> Story bible</TabsTrigger>
            <TabsTrigger value="characters"><Users /> Characters</TabsTrigger>
            <TabsTrigger value="flow"><Film /> Google Flow</TabsTrigger>
            <TabsTrigger value="models"><Cpu /> Models</TabsTrigger>
          </TabsList>
          <TabsContent value="scenes" className="flex flex-col gap-4">
            {d.scenes.map((s) => <SceneCard key={s.id} scene={s} models={models.data ?? []} templates={templates.data ?? []} busy={Boolean(storyJob) || d.pending.some((j) => j.sceneId === s.id)} />)}
          </TabsContent>
          <TabsContent value="bible"><BibleView d={d} /></TabsContent>
          <TabsContent value="characters"><CharactersView d={d} /></TabsContent>
          <TabsContent value="flow"><FlowView storyId={d.story.id} /></TabsContent>
          <TabsContent value="models">{models.data ? <ModelsView models={models.data} /> : <Skeleton className="h-60" />}</TabsContent>
        </Tabs>
      )}
      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground"><History className="size-3.5" /> Every change is a new version; regenerating or editing a prompt never changes the story.</p>
    </>
  );
}

export default function PromptStudioPage() {
  return (
    <>
      <PageHeader title="Prompt Studio" description="Story-aware, scene-by-scene prompts: review, edit, regenerate and target a model." />
      <Suspense fallback={<Skeleton className="h-96" />}><Studio /></Suspense>
    </>
  );
}
