"use client";

import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { BookOpen, Clapperboard, Film, ListChecks, ListPlus, Sparkles, Wand2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  ago, api, errMsg, AGE_GROUP_LABELS, type AgeGroup, CATEGORY_LABELS, EPIC_CATEGORIES, SOURCE_CATEGORIES, STORY_SOURCE_LABELS, type StorySource,
  LANGUAGE_LABELS, LENGTH_OPTIONS, type LengthSec, STYLE_LABELS, STYLE_OPTIONS, type StyleId,
} from "@/lib/api";
import { useSettings } from "@/lib/queries";
import { useApiMutation, useJobs, useProjects, useStories } from "@/lib/queries";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function Empty({ text }: { text: string }) {
  return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">{text}</CardContent></Card>;
}

/** One visual style per reel; the swatches preview each style's palette. */
function StylePicker({ value, onChange }: { value: StyleId; onChange: (s: StyleId) => void }) {
  return (
    <div className="w-full" role="radiogroup" aria-label="Visual style">
      <span className="text-xs font-medium text-muted-foreground">Visual style</span>
      <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STYLE_OPTIONS.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={value === s.id} onClick={() => onChange(s.id)}
            className={cn("rounded-lg border p-2 text-left transition-colors hover:bg-muted/50", value === s.id ? "border-primary bg-primary/10" : "border-border")}>
            <div className="flex h-6 overflow-hidden rounded">{s.swatches.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}</div>
            <div className="mt-1.5 text-sm font-medium">{s.label}</div>
            <div className="text-xs leading-snug text-muted-foreground">{s.bestFor}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

const SOURCE_HINT: Record<StorySource, string> = {
  generated: "The AI invents a new story for the category (fables, history and epics are retold faithfully).",
  idea: "Give a premise; the AI develops it into a full story, then designs any new characters once and keeps them permanently.",
  full_story: "Paste your complete story. The AI only breaks it into scenes, prompts and voices; it does not change what happens.",
  continuation: "The next episode of an existing story, with the same permanent characters.",
};

function NewContent({ continueFrom, onContinueHandled }: { continueFrom: string | null; onContinueHandled: () => void }) {
  const [category, setCategory] = useState("rabbit_squirrel_adventure");
  const [pickedMode, setMode] = useState<StorySource>("generated");
  const mode: StorySource = continueFrom ? "continuation" : pickedMode;
  const [sourceText, setSourceText] = useState("");
  const [pickedParent, setParent] = useState("");
  const parentStoryId = continueFrom ?? pickedParent;
  const [pickedAge, setAge] = useState<AgeGroup | null>(null);
  const stories = useStories();
  const settings = useSettings();
  const ageGroup = pickedAge ?? settings.data?.generation.ageGroup ?? "age_4_6";
  const [pickedLanguage, setLanguage] = useState<string | null>(null);
  const language = pickedLanguage ?? settings.data?.generation.language ?? "hi";
  const [pickedLength, setLength] = useState<LengthSec | null>(null);
  const durationSec = pickedLength ?? settings.data?.generation.durationSec ?? 60;
  const [picked, setPicked] = useState<StyleId | null>(null);
  const style = picked ?? settings.data?.generation.style ?? "storybook";
  const reel = useApiMutation((b: object) => api.post("/reels/generate", b), [["jobs"], ["projects"]]);
  const story = useApiMutation((b: object) => api.post("/stories/generate", b), [["stories"]]);
  const parent = stories.data?.find((s) => s.id === parentStoryId);
  // a continuation keeps the previous episode's category
  const body = {
    category: parent && mode === "continuation" ? parent.category : category, language, style, durationSec, ageGroup, mode,
    sourceText: sourceText.trim() || undefined, parentStoryId: mode === "continuation" ? parentStoryId || undefined : undefined,
  };
  const invalid = ((mode === "idea" || mode === "full_story") && sourceText.trim().length < 10) || (mode === "continuation" && !parentStoryId);
  const done = () => { setSourceText(""); onContinueHandled(); };
  const textLabel = mode === "idea" ? "Your idea" : mode === "full_story" ? "Your story (any language)" : "Direction for the next episode (optional)";
  const placeholder = mode === "idea" ? "A curious baby lion follows a colourful butterfly and makes a new friend…" : mode === "full_story" ? "Once upon a time…" : "e.g. they visit the river and learn to share";
  return (
    <Card className="mb-5">
      <CardContent className="flex flex-wrap items-end gap-3 py-4">
        <div className="w-full" role="radiogroup" aria-label="Story source">
          <span className="text-xs font-medium text-muted-foreground">Story source</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {(Object.keys(STORY_SOURCE_LABELS) as StorySource[]).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); if (m !== "continuation") onContinueHandled(); }}
                className={cn("rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted/50", mode === m ? "border-primary bg-primary/10 font-medium" : "border-border")}>{STORY_SOURCE_LABELS[m]}</button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{SOURCE_HINT[mode]}</p>
        </div>
        {mode === "continuation" && (
          <div className="flex w-full flex-col gap-1.5 sm:w-96"><span className="text-xs font-medium text-muted-foreground">Continue from</span>
            <NativeSelect value={parentStoryId} onChange={(e) => { setParent(e.target.value); onContinueHandled(); }}>
              <option value="">Choose a story…</option>
              {stories.data?.map((s) => <option key={s.id} value={s.id}>{s.title}{s.episodeNo && s.episodeNo > 1 ? ` (ep. ${s.episodeNo})` : ""}</option>)}
            </NativeSelect></div>
        )}
        {mode !== "generated" && (
          <div className="flex w-full flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{textLabel}</span>
            <Textarea value={sourceText} onChange={(e) => setSourceText(e.target.value)} rows={mode === "full_story" ? 8 : 3} maxLength={20000} placeholder={placeholder} /></div>
        )}
        <div className="flex min-w-56 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Category</span>
          <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></div>
        <div className="flex w-40 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Language</span>
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>{Object.entries(LANGUAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></div>
        <div className="flex w-40 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Audience</span>
          <NativeSelect value={ageGroup} onChange={(e) => setAge(e.target.value as AgeGroup)}>{Object.entries(AGE_GROUP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></div>
        <div className="flex w-36 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Length</span>
          <NativeSelect value={durationSec} onChange={(e) => setLength(Number(e.target.value) as LengthSec)}>{LENGTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></div>
        <Button disabled={reel.isPending || invalid} onClick={() => reel.mutate(body, { onSuccess: () => { done(); toast.success(`New ${durationSec / 60}-min reel queued: story, scene prompts, then images, voice and render (roughly ${durationSec / 60 * 60}-${durationSec / 60 * 90} min on this CPU)`); }, onError: (e) => toast.error(errMsg(e)) })}><Film /> Generate reel</Button>
        <Button variant="outline" disabled={story.isPending || invalid} onClick={() => story.mutate(body, { onSuccess: () => { done(); toast.success("Story queued: understanding, script, then scene prompts (about 20-40 min)"); }, onError: (e) => toast.error(errMsg(e)) })}><Sparkles /> Story + prompts</Button>
        <StylePicker value={style} onChange={setPicked} />
        {EPIC_CATEGORIES.includes(category) && mode === "generated" && <p className="w-full text-xs text-muted-foreground">{CATEGORY_LABELS[category]} uses its own characters (see Character Studio), not Rabbit &amp; Squirrel.</p>}
        {SOURCE_CATEGORIES.includes(category) && <p className="w-full text-xs text-muted-foreground">Source-faithful category: names, places and the order of events stay true to the tradition or history; nothing is invented.</p>}
        <p className="w-full text-xs text-muted-foreground">Heavy AI jobs run one at a time on this machine; finished reels land in the Review Studio. Nothing is published automatically.</p>
      </CardContent>
    </Card>
  );
}

export default function ContentPage() {
  const stories = useStories();
  const [continueFrom, setContinueFrom] = useState<string | null>(null);
  const projects = useProjects();
  const jobs = useJobs();
  const produce = useApiMutation((id: string) => api.post(`/stories/${id}/produce`), [["projects"], ["jobs"]]);

  return (
    <>
      <PageHeader title="Content Studio" description="Stories, scripts, video projects and generation history." />
      <NewContent continueFrom={continueFrom} onContinueHandled={() => setContinueFrom(null)} />
      <Tabs defaultValue="stories">
        <TabsList className="mb-4">
          <TabsTrigger value="stories"><BookOpen /> Stories</TabsTrigger>
          <TabsTrigger value="projects"><Clapperboard /> Video projects</TabsTrigger>
          <TabsTrigger value="jobs"><ListChecks /> Generation history</TabsTrigger>
        </TabsList>

        <TabsContent value="stories">
          {stories.isPending && <Skeleton className="h-40" />}
          {stories.isError && <p className="text-sm text-red-600 dark:text-red-400">{errMsg(stories.error)}</p>}
          {stories.data?.length === 0 && <Empty text="No stories yet. The story engine arrives in Phase 5." />}
          <div className="grid gap-3 md:grid-cols-2">
            {stories.data?.map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle>{s.title}</CardTitle>
                  <CardDescription>
                    {[CATEGORY_LABELS[s.category] ?? s.category, LANGUAGE_LABELS[s.language] ?? s.language, STYLE_LABELS[s.style] ?? s.style,
                      s.ageGroup && AGE_GROUP_LABELS[s.ageGroup], s.sourceMode && s.sourceMode !== "generated" && STORY_SOURCE_LABELS[s.sourceMode],
                      s.episodeNo && s.episodeNo > 1 && `episode ${s.episodeNo}`, ago(s.createdAt)].filter(Boolean).join(" · ")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p><span className="text-foreground">Hook:</span> {s.hook}</p>
                  <p className="mt-1"><span className="text-foreground">Moral:</span> {s.moral}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={produce.isPending} onClick={() => produce.mutate(s.id, { onSuccess: () => toast.success("Reel production queued"), onError: (e) => toast.error(errMsg(e)) })}><Film /> Produce reel</Button>
                    <Link href={`/prompts?story=${s.id}`}><Button size="sm" variant="outline"><Wand2 /> Prompts</Button></Link>
                    <Button size="sm" variant="ghost" onClick={() => { setContinueFrom(s.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}><ListPlus /> Next episode</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="projects">
          {projects.isPending && <Skeleton className="h-40" />}
          {projects.data?.length === 0 && <Empty text="No video projects yet. Reel production arrives in Phase 6." />}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {projects.data?.map((p) => (
              <Card key={p.id} className="overflow-hidden">
                <div className="aspect-9/16 bg-muted/40">{p.latestVersion?.thumbnailUrl && <img src={p.latestVersion.thumbnailUrl} alt="" className="size-full object-cover" />}</div>
                <CardContent className="py-3 text-sm">
                  <div className="font-medium">{p.story.title}</div>
                  <div className="mt-1 flex items-center gap-2"><Badge variant="outline">{p.status.replace("_", " ")}</Badge>{p.latestVersion && <span className="text-xs text-muted-foreground">v{p.latestVersion.versionNo}</span>}</div>
                  {p.latestJob && p.latestJob.status === "active" && <Progress className="mt-2" value={p.latestJob.progress} />}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="jobs">
          {jobs.isPending && <Skeleton className="h-40" />}
          {jobs.data?.length === 0 && <Empty text="No generation jobs yet." />}
          {jobs.data && jobs.data.length > 0 && (
            <Card>
              <CardContent className="divide-y divide-border/60 py-2 text-sm">
                {jobs.data.map((j) => (
                  <div key={j.id} className="grid gap-1 py-2.5 sm:grid-cols-[1fr_120px_160px_90px] sm:items-center">
                    <div className="truncate">{j.project?.story.title ?? j.projectId}<div className="text-xs text-muted-foreground">job {j.bullJobId} · attempt {j.attempt}/{j.maxAttempts}</div></div>
                    <span className={cn("text-xs", j.status === "failed" ? "text-red-600 dark:text-red-400" : j.status === "completed" ? "text-emerald-600 dark:text-emerald-400" : "text-sky-600 dark:text-sky-300")}>{j.status}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">{j.stage}<Progress className="h-1.5 w-16" value={j.progress} /></div>
                    <span className="text-xs text-muted-foreground">{ago(j.createdAt)}</span>
                    {j.error && <div className="text-xs text-red-600 dark:text-red-400 sm:col-span-4">{j.error.message}</div>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
