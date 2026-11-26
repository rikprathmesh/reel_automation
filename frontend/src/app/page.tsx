"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Activity, AlertTriangle, ArrowRight, Bot, CalendarClock, CheckCircle2, Clapperboard, Database, Film, Image as ImageIcon, Link2, Loader2, Play, RefreshCw, Send, Server, Table2, XCircle,
} from "lucide-react";
import { ago, api, errMsg, type HealthCheck, type ProjectSummary, type Stats } from "@/lib/api";
import { qk, useActivity, useApiMutation, useHealth, useProjects, useSettings, useStats } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

const SERVICES = [
  { key: "database", label: "PostgreSQL", icon: Database, hint: "services.msc → postgresql-x64-18" },
  { key: "redis", label: "Redis job queue", icon: Server, hint: "Start redis-server.exe reelforge.conf" },
  { key: "llm", label: "Ollama (local AI)", icon: Bot, hint: "Open the Ollama app" },
  { key: "comfyui", label: "ComfyUI (images)", icon: ImageIcon, hint: "Start ComfyUI (start-all.ps1)" },
  { key: "media", label: "Media service", icon: Film, hint: "Start media-service (start-all.ps1)" },
  { key: "reference", label: "Reference service", icon: Link2, hint: "Start reference-service (start-all.ps1)" },
] as const;

type Tone = "primary" | "warning" | "success" | "destructive";
const TONE: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/12 text-warning",
  success: "bg-success/12 text-success",
  destructive: "bg-destructive/10 text-destructive",
};

function StatCard({ label, value, icon: Icon, tone, sub, href, i }: { label: string; value?: number; icon: typeof Film; tone: Tone; sub: string; href: string; i: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
      <Card className="h-full">
        <CardContent className="flex flex-col gap-4 py-1">
          <div className="flex items-center gap-3">
            <span className={cn("grid size-11 place-items-center rounded-xl", TONE[tone])}><Icon className="size-5" /></span>
            <div className="text-sm font-medium text-muted-foreground">{label}</div>
          </div>
          {value === undefined ? <Skeleton className="h-9 w-16" /> : <div className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">{value.toLocaleString()}</div>}
          <Link href={href} className="group/link flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground hover:text-foreground">
            <span>{sub}</span>
            <ArrowRight className="size-3.5 transition-transform group-hover/link:translate-x-0.5" />
          </Link>
        </CardContent>
      </Card>
    </motion.div>
  );
}

const DAYS = 14;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Reels created per day over the last 14 days (single series, so no legend: the title names it). */
function ProductionChart({ projects }: { projects?: ProjectSummary[] }) {
  const [table, setTable] = useState(false);
  const days = useMemo(() => {
    const out: { date: Date; label: string; count: number }[] = [];
    const now = new Date();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({ date: d, label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), count: 0 });
    }
    const idx = new Map(out.map((d, i) => [dayKey(d.date), i]));
    for (const p of projects ?? []) {
      const i = idx.get(dayKey(new Date(p.createdAt)));
      if (i !== undefined) out[i]!.count++;
    }
    return out;
  }, [projects]);
  const max = Math.max(4, ...days.map((d) => d.count));
  const top = Math.ceil(max / 2) * 2;
  const ticks = [top, top / 2, 0];
  const total = days.reduce((a, d) => a + d.count, 0);

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="font-semibold">Reels produced</CardTitle>
          <CardDescription>Per day, last {DAYS} days · {total} total</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setTable((t) => !t)} aria-pressed={table}><Table2 /> {table ? "Chart" : "Table"}</Button>
      </CardHeader>
      <CardContent>
        {!projects ? <Skeleton className="h-56 w-full" /> : table ? (
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5 font-medium">Day</th><th className="py-1.5 text-right font-medium">Reels</th></tr></thead>
              <tbody className="divide-y divide-border">{days.map((d) => <tr key={d.label}><td className="py-1.5">{d.label}</td><td className="py-1.5 text-right tabular-nums">{d.count}</td></tr>)}</tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-56 gap-3">
            <div className="flex flex-col justify-between pb-6 text-right text-[11px] text-muted-foreground tabular-nums">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
            <div className="relative flex-1">
              <div className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
                {ticks.map((t) => <div key={t} className="h-px bg-border" />)}
              </div>
              <div className="absolute inset-x-0 top-0 bottom-6 flex items-end">
                {days.map((d, i) => (
                  <div key={d.label} className="group/bar relative flex h-full flex-1 items-end justify-center">
                    <div
                      className="w-full max-w-6 rounded-t-[4px] bg-primary transition-opacity group-hover/bar:opacity-80"
                      style={{ height: `${(d.count / top) * 100}%`, minHeight: d.count ? 4 : 0 }}
                    />
                    <div className={cn(
                      "pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md group-hover/bar:block",
                      i > DAYS - 3 ? "right-0" : i < 2 ? "left-0" : "left-1/2 -translate-x-1/2",
                    )}>
                      <span className="font-medium">{d.count}</span> reel{d.count === 1 ? "" : "s"} · {d.label}
                    </div>
                  </div>
                ))}
              </div>
              <div className="absolute inset-x-0 bottom-0 flex text-[11px] text-muted-foreground">
                {days.map((d, i) => <span key={d.label} className="flex-1 text-center">{i % 2 === (DAYS - 1) % 2 ? d.date.getDate() : ""}</span>)}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PIPELINE = [
  ["generating", "In production"], ["awaitingReview", "Awaiting review"], ["approved", "Approved"], ["published", "Published"], ["rejected", "Rejected"],
] as const;

/** Where every reel currently sits. Horizontal bars, one hue; the row label carries identity. */
function PipelineCard({ stats }: { stats?: Stats }) {
  const max = Math.max(1, ...PIPELINE.map(([k]) => stats?.[k] ?? 0));
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-semibold">Pipeline</CardTitle>
        <CardDescription>Where every reel is right now</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {PIPELINE.map(([k, label]) => {
          const v = stats?.[k];
          return (
            <div key={k}>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                {v === undefined ? <Skeleton className="h-4 w-6" /> : <span className="font-semibold tabular-nums">{v}</span>}
              </div>
              <div className="h-2 rounded-full bg-muted">
                <div className="h-2 rounded-full bg-primary transition-[width]" style={{ width: `${((v ?? 0) / max) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function TodayCard({ projects }: { projects?: ProjectSummary[] }) {
  const settings = useSettings();
  const s = settings.data?.schedule;
  const today = dayKey(new Date());
  const made = (projects ?? []).filter((p) => dayKey(new Date(p.createdAt)) === today);
  const done = made.filter((p) => !["queued", "generating", "failed"].includes(p.status)).length;
  const target = s?.targetCount ?? 5;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="font-semibold">Today&apos;s production</CardTitle>
          <CardDescription>{s ? (s.enabled ? `Daily schedule on · starts ${s.startTime}` : "Daily schedule is off") : "Loading schedule…"}</CardDescription>
        </div>
        <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><CalendarClock className="size-5" /></span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!projects ? <Skeleton className="h-10 w-full" /> : (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tabular-nums">{done}</span>
              <span className="text-sm text-muted-foreground">of {target} reels finished</span>
            </div>
            <Progress value={Math.min(100, (done / Math.max(1, target)) * 100)} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{made.length - done} in progress or failed today</span>
              <Link href="/settings" className="text-primary hover:underline">Schedule settings</Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Starts a stopped service in its own window on this machine, then re-checks health while it boots. */
function StartButton({ name, label }: { name: string; label: string }) {
  const qc = useQueryClient();
  const start = useApiMutation(() => api.post<{ ok: boolean; result: string }>(`/health/services/${name}/start`, {}), []);
  return (
    <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-xs" disabled={start.isPending}
      onClick={() => start.mutate(undefined, {
        onSuccess: (r) => {
          toast.success(r.result === "already running" ? `${label} is already running; it may still be starting up` : `${label} starting in its own window`);
          // services need a few seconds (ComfyUI ~30s) before they answer
          for (const ms of [5_000, 15_000, 35_000]) setTimeout(() => void qc.invalidateQueries({ queryKey: qk.health }), ms);
        },
        onError: (e) => toast.error(errMsg(e)),
      })}>
      {start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start
    </Button>
  );
}

function HealthCard() {
  const health = useHealth();
  const checks = health.data?.checks;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="font-semibold">System health</CardTitle>
          <CardDescription>Checked every 15 seconds</CardDescription>
        </div>
        {health.data && <Badge variant={health.data.status === "ok" ? "secondary" : "destructive"}>{health.data.status === "ok" ? "core up" : "degraded"}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {health.isError && <p className="pb-2 text-sm text-destructive">{errMsg(health.error)}</p>}
        {SERVICES.map(({ key, label, icon: Icon, hint }) => {
          const c: HealthCheck | undefined = checks?.[key];
          return (
            <div key={key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{label}</div>
                {c ? <div className={cn("truncate text-xs", c.ok ? "text-muted-foreground" : "text-destructive")} title={c.detail}>{c.ok ? c.detail : `${c.detail.split("\n").filter(Boolean).pop()} → ${hint}`}</div> : <Skeleton className="mt-1 h-3 w-3/4" />}
              </div>
              {c && !c.ok && <StartButton name={key} label={label} />}
              {c ? (c.ok ? <CheckCircle2 className={cn("mt-1 size-4 shrink-0", c.busy ? "text-warning" : "text-success")} aria-label={c.busy ? "busy" : "up"} /> : <XCircle className="mt-1 size-4 shrink-0 text-destructive" aria-label="down" />) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

const LEVELS = [["all", "All"], ["warn", "Warnings"], ["error", "Errors"]] as const;
const ENTITY_TONE: Record<string, string> = {
  project: "bg-primary/10 text-primary", story: "bg-info/15 text-info", reference: "bg-warning/12 text-warning",
  account: "bg-success/12 text-success", publishing: "bg-success/12 text-success", character: "bg-primary/10 text-primary",
};

function ActivityCard() {
  const activity = useActivity(40);
  const [level, setLevel] = useState<(typeof LEVELS)[number][0]>("all");
  const rows = (activity.data ?? []).filter((a) => level === "all" || a.level === level);
  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 font-semibold"><Activity className="size-4" /> Recent activity</CardTitle>
          <CardDescription>Every important operation is recorded. Updates live.</CardDescription>
        </div>
        <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Filter activity">
          {LEVELS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={level === k} onClick={() => setLevel(k)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", level === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {activity.isPending && <div className="flex flex-col gap-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
        {activity.isError && <p className="text-sm text-destructive">{errMsg(activity.error)}</p>}
        {activity.data && rows.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nothing here.</p>}
        <ul className="flex max-h-[460px] flex-col divide-y divide-border overflow-y-auto pr-1">
          {rows.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-3 first:pt-0">
              <span className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase",
                a.level === "error" ? "bg-destructive/10 text-destructive" : a.level === "warn" ? "bg-warning/12 text-warning" : ENTITY_TONE[a.entityType] ?? "bg-muted text-muted-foreground",
              )}>
                {a.level === "error" ? <XCircle className="size-4" /> : a.level === "warn" ? <AlertTriangle className="size-4" /> : a.entityType.slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm leading-snug">{a.message}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{a.entityType} · {a.action.replaceAll("_", " ")}</div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const stats = useStats();
  const projects = useProjects();
  const health = useHealth();
  const activity = useActivity(40);
  const s = stats.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Production, review queue, publishing and system health at a glance."
        actions={<Button variant="outline" size="sm" onClick={() => { void stats.refetch(); void projects.refetch(); void health.refetch(); void activity.refetch(); }}><RefreshCw /> Refresh</Button>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard i={0} label="Total reels" value={s?.total} icon={Film} tone="primary" sub={s ? `${s.generating} in production now` : "…"} href="/content" />
        <StatCard i={1} label="Awaiting review" value={s?.awaitingReview} icon={Clapperboard} tone="warning" sub="Open the Review Studio" href="/review" />
        <StatCard i={2} label="Published" value={s?.published} icon={Send} tone="success" sub={s ? `${s.approved} approved, not yet published` : "…"} href="/publishing" />
        <StatCard i={3} label="Failed jobs" value={s?.failedJobs} icon={AlertTriangle} tone="destructive" sub={s ? `${s.rejected} reels rejected` : "…"} href="/content" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8"><ProductionChart projects={projects.data} /></div>
        <div className="lg:col-span-4"><PipelineCard stats={s} /></div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-5 xl:col-span-4">
          <TodayCard projects={projects.data} />
          <HealthCard />
        </div>
        <div className="lg:col-span-7 xl:col-span-8"><ActivityCard /></div>
      </div>
    </>
  );
}
