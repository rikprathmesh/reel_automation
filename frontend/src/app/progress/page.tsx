"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CheckCircle2, Circle, Clapperboard, Film, Image as ImageIcon, Loader2, Music, PenLine, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { api, ago, CATEGORY_LABELS, LANGUAGE_LABELS, type ActivityEntry, type GenerationJob, type ProjectSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Live generation monitor. Combines three real sources (no estimates presented as facts):
 *  - /queues        BullMQ counts: is something running, how many reels are waiting
 *  - /jobs          per-reel render job: stage + percent, mirrored from the worker
 *  - /activity      story-writing events (the story step runs before a render job exists)
 * The live event stream (app shell) invalidates these queries; a 10 s poll is the fallback.
 */

const POLL = 10_000;

/** Pipeline steps in order, with the render job's progress range for each (see production.service.ts). */
const STEPS = [
  { key: "story", label: "Writing: story, characters, script, scene prompts", icon: PenLine, from: 0, to: 0, typical: "40–60 min" },
  { key: "storyboard", label: "Making the scenes (one job each: picture + voices)", icon: ImageIcon, from: 2, to: 80, typical: "~4–5 min per scene" },
  { key: "editing", label: "Scene timing & camera motion", icon: Film, from: 82, to: 88, typical: "1–3 min" },
  { key: "audio", label: "Adding music & sounds", icon: Music, from: 88, to: 90, typical: "< 1 min" },
  { key: "render", label: "Building the final video", icon: Clapperboard, from: 90, to: 96, typical: "2–5 min" },
  { key: "validation", label: "Quality check", icon: ShieldCheck, from: 96, to: 100, typical: "< 1 min" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

// "voice" / "animation" are stages of the old single-job pipeline; they now happen inside the scene jobs
const stepOf = (stage: string): StepKey => (stage === "voice" || stage === "animation" ? "storyboard" : (STEPS.find((s) => s.key === stage)?.key ?? "storyboard"));

function fmtDuration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

type QueueCounts = Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }>;

function StepList({ current, progress }: { current: StepKey; progress: number }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-col gap-1">
      {STEPS.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        const Icon = s.icon;
        const pct = active && s.to > s.from ? Math.min(100, Math.max(0, ((progress - s.from) / (s.to - s.from)) * 100)) : 0;
        return (
          <li key={s.key} className={cn("flex items-center gap-3 rounded-lg px-3 py-2", active && "bg-primary/8")}>
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", done ? "bg-success/15 text-success" : active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
              {done ? <CheckCircle2 className="size-4" /> : active ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm", active ? "font-medium" : done ? "text-muted-foreground" : "text-muted-foreground/80")}>{s.label}</div>
              {active && s.to > s.from && <Progress className="mt-1.5 h-1.5" value={pct} />}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{done ? "done" : active ? (s.to > s.from ? `${Math.round(pct)}%` : "working…") : s.typical}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Sub-steps of the writing phase, ticked off from the pipeline's own activity events (newest first in `events`). */
function StoryPhase({ events, now }: { events: ActivityEntry[]; now: number }) {
  // a Prompt Studio job (prompts for an existing story) is not a new reel: show only its prompt count
  const lastAny = events.find((e) => e.action === "generation_requested" || e.action === "prompts_requested");
  if (lastAny?.action === "prompts_requested") {
    const since = events.filter((e) => new Date(e.createdAt) >= new Date(lastAny.createdAt));
    const written = since.filter((e) => e.action === "scene_prompt_written");
    const total = written[0]?.message.match(/of (\d+)/)?.[1];
    return (
      <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium"><Sparkles className="size-4 text-primary" /> Writing scene prompts for an existing story (Prompt Studio)</div>
        <p className="mt-2 text-muted-foreground">{written.length ? `${written.length} scene prompt(s) written${total ? ` · latest: ${written[0]!.message}` : ""}` : "Starting…"}</p>
        <p className="mt-1 text-xs text-muted-foreground">Requested {fmtDuration(now - new Date(lastAny.createdAt).getTime())} ago. Each scene prompt takes about 2–4 min on this laptop. No video is made by this job.</p>
      </div>
    );
  }
  const lastReq = events.find((e) => e.action === "generation_requested");
  const since = lastReq ? events.filter((e) => new Date(e.createdAt) >= new Date(lastReq.createdAt)).reverse() : [];
  const at = (action: string) => since.find((e) => e.action === action);
  const redrafts = since.filter((e) => e.action === "draft_rejected" || e.action === "duplicate_rejected" || e.action === "draft_unfaithful").length;
  const designed = since.filter((e) => e.action === "created_from_story");
  const promptsDone = since.filter((e) => e.action === "scene_prompt_written").length;
  const started = lastReq ? new Date(lastReq.createdAt).getTime() : null;
  const aiStory = Boolean(at("premise_invented")) || !/My idea|full story/i.test(lastReq?.message ?? "");
  const steps = [
    ...(aiStory ? [{ label: "Choosing a fresh story idea", done: at("premise_invented") ?? at("understood") }] : []),
    { label: "Understanding the story (characters, places, events)", done: at("understood") },
    // there is no separate "characters finished" event: characters are designed first, then the script is written
    { label: `Designing new characters${designed.length ? ` (done: ${designed.map((d) => d.message.match(/character (.+?) designed/)?.[1] ?? "1").join(", ")})` : ""}, then writing the script${redrafts ? ` (draft ${redrafts + 1})` : ""}`, done: at("generated") },
    { label: `Writing the scene prompts${promptsDone ? ` (${promptsDone} done)` : ""}`, done: at("prompts_generated") },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium"><Sparkles className="size-4 text-primary" /> The local AI is writing (one step at a time)</div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={s.label} className={cn("flex items-center gap-2", i === current ? "text-foreground" : "text-muted-foreground")}>
            {s.done ? <CheckCircle2 className="size-3.5 text-success" /> : i === current ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <Circle className="size-3.5" />}
            <span>{s.label}</span>
            {s.done && <span className="text-xs">· {new Date(s.done.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
          </li>
        ))}
      </ul>
      {started && <p className="mt-2 text-xs text-muted-foreground">Started {fmtDuration(now - started)} ago. On this laptop writing takes about 40–60 min (understanding ~5 min, each new character ~3–6 min, script ~10 min, each scene prompt ~2–4 min).</p>}
    </div>
  );
}

function ActiveReel({ job, project, storyEvents, now, writingStory }: { job: GenerationJob | null; project: ProjectSummary | null; storyEvents: ActivityEntry[]; now: number; writingStory: boolean }) {
  const current: StepKey = writingStory || !job ? "story" : stepOf(job.stage);
  const progress = job?.progress ?? 0;
  const started = job?.startedAt ? new Date(job.startedAt).getTime() : null;
  const elapsed = started ? now - started : 0;
  // rough remaining time from the render job's own pace; only shown once there is enough signal
  const eta = !writingStory && started && progress >= 10 && progress < 100 ? (elapsed / progress) * (100 - progress) : null;
  const promptJob = storyEvents.find((e) => e.action === "generation_requested" || e.action === "prompts_requested")?.action === "prompts_requested";
  const title = writingStory ? (promptJob ? "Scene prompts" : "New reel") : (project?.story.title ?? job?.project?.story.title ?? "Reel");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="font-semibold">{title}</CardTitle>
            <CardDescription>
              {project ? `${CATEGORY_LABELS[project.story.category] ?? project.story.category} · ${LANGUAGE_LABELS[project.story.language] ?? project.story.language}` : "Story not written yet"}
              {job && job.attempt > 1 ? ` · attempt ${job.attempt} of ${job.maxAttempts}` : ""}
            </CardDescription>
          </div>
          <Badge className="gap-1"><Loader2 className="size-3 animate-spin" /> In progress</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!writingStory && job && (
          <div>
            <div className="mb-2 flex items-end justify-between gap-2">
              <span className="text-[32px] leading-none font-semibold tabular-nums">{progress}%</span>
              <span className="text-right text-xs text-muted-foreground">
                {started && <>Running for {fmtDuration(elapsed)}<br /></>}
                {eta !== null ? <>About {fmtDuration(eta)} left (rough estimate)</> : "Estimating time left…"}
              </span>
            </div>
            <Progress className="h-2.5" value={progress} />
          </div>
        )}
        {writingStory && <StoryPhase events={storyEvents} now={now} />}
        <StepList current={current} progress={progress} />
      </CardContent>
    </Card>
  );
}

export default function ProgressPage() {
  const now = useNow();
  const queues = useQuery({ queryKey: ["queues"], queryFn: () => api.get<QueueCounts>("/queues"), refetchInterval: POLL });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<GenerationJob[]>("/jobs"), refetchInterval: POLL });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectSummary[]>("/projects"), refetchInterval: POLL });
  const activity = useQuery({ queryKey: ["activity", 80], queryFn: () => api.get<ActivityEntry[]>("/activity?limit=80"), refetchInterval: POLL });

  const prod = queues.data?.production;
  const busy = (prod?.active ?? 0) > 0;
  const runningJob = useMemo(() => jobs.data?.find((j) => ["active", "retrying", "queued"].includes(j.status)) ?? null, [jobs.data]);
  const runningProject = useMemo(() => (runningJob ? projects.data?.find((p) => p.id === runningJob.projectId) ?? null : null), [runningJob, projects.data]);
  const storyEvents = useMemo(() => (activity.data ?? []).filter((e) => e.entityType === "story" || e.entityType === "project" || (e.entityType === "character" && e.action === "created_from_story")
    // job retries and failures must be visible here, otherwise a failed reel just disappears from the page
    || (e.entityType === "job" && e.level !== "info")), [activity.data]);
  // a reel's story is written before its render job exists: queue busy + no active render job = story step
  const writingStory = busy && !(runningJob && runningJob.status !== "queued");
  const history = (jobs.data ?? []).filter((j) => j.status === "completed" || j.status === "failed").slice(0, 8);
  const loading = queues.isLoading || jobs.isLoading;

  return (
    <>
      <PageHeader title="Generation Progress" description="What the studio is making right now, how far along it is, and what finished recently. Updates live." />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          {loading ? (
            <Card><CardContent className="flex flex-col gap-3 py-6"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-3 w-full" /><Skeleton className="h-40 w-full" /></CardContent></Card>
          ) : busy || runningJob ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <ActiveReel job={runningJob} project={runningProject} storyEvents={storyEvents} now={now} writingStory={writingStory} />
            </motion.div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <Circle className="size-10 text-muted-foreground/50" />
                <div className="font-medium">Nothing is being generated right now</div>
                <p className="max-w-sm text-sm text-muted-foreground">Start a reel from Content Studio, or turn on the daily schedule in Settings.</p>
                <Link href="/content" className={buttonVariants({ variant: "outline" })}>Go to Content Studio</Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="font-semibold">Recently finished</CardTitle><CardDescription>Last {history.length || "few"} reels and how long each took</CardDescription></CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {history.length === 0 && <p className="text-sm text-muted-foreground">No finished reels yet.</p>}
              {history.map((j) => {
                const took = j.startedAt && j.completedAt ? new Date(j.completedAt).getTime() - new Date(j.startedAt).getTime() : null;
                const ok = j.status === "completed";
                return (
                  <div key={j.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    {ok ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{j.project?.story.title ?? "Reel"}</div>
                      <div className="truncate text-xs text-muted-foreground" title={j.error?.message}>
                        {ok ? `Rendered${took ? ` in ${fmtDuration(took)}` : ""}` : `Failed at ${j.stage}: ${j.error?.message ?? "unknown error"}`} · {ago(j.completedAt ?? j.createdAt)}
                      </div>
                    </div>
                    {ok && <Link href="/review" className={buttonVariants({ size: "sm", variant: "ghost" })}>Review</Link>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader><CardTitle className="font-semibold">Queue</CardTitle><CardDescription>Reels are made one at a time on this machine</CardDescription></CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-center">
              {[["Running", prod?.active], ["Waiting", (prod?.waiting ?? 0) + (prod?.delayed ?? 0)], ["Failed (all time)", prod?.failed]].map(([label, n]) => (
                <div key={label as string} className="rounded-lg bg-muted/40 py-3">
                  <div className="text-2xl font-semibold tabular-nums">{queues.data ? ((n as number | undefined) ?? 0) : "–"}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="font-semibold">Live log</CardTitle><CardDescription>Story and video events, retries and failures (red), newest first</CardDescription></CardHeader>
            <CardContent className="flex max-h-[520px] flex-col gap-2.5 overflow-y-auto">
              {storyEvents.length === 0 && <p className="text-sm text-muted-foreground">No events yet.</p>}
              {storyEvents.slice(0, 25).map((e) => (
                <div key={e.id} className="text-sm">
                  <div className={cn("leading-snug", e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-warning" : "")}>{e.message}</div>
                  <div className="text-xs text-muted-foreground">{ago(e.createdAt)}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
