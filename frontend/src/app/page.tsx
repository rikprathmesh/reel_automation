"use client";

import { motion } from "framer-motion";
import { Activity, Bot, Database, Film, Link2, RefreshCw, Server } from "lucide-react";
import { ago, errMsg, type HealthCheck } from "@/lib/api";
import { useActivity, useHealth, useStats } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const SERVICES = [
  { key: "database", label: "PostgreSQL", icon: Database, hint: "services.msc → postgresql-x64-18" },
  { key: "redis", label: "Redis (job queue)", icon: Server, hint: "Start redis-server.exe reelforge.conf" },
  { key: "llm", label: "Ollama (local AI)", icon: Bot, hint: "Open the Ollama app" },
  { key: "media", label: "Media service", icon: Film, hint: "Built in Phase 6" },
  { key: "reference", label: "Reference service", icon: Link2, hint: "Built in Phase 4" },
] as const;

function ServiceCard({ label, icon: Icon, check, hint, i }: { label: string; icon: typeof Database; check?: HealthCheck; hint: string; i: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
      <Card className="h-full">
        <CardContent className="flex flex-col gap-2 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4 text-muted-foreground" />{label}</div>
            {check ? (
              <span className={cn("size-2.5 rounded-full", check.ok ? "bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60" : "bg-red-500")} />
            ) : <Skeleton className="size-2.5 rounded-full" />}
          </div>
          {check ? (
            <>
              <div className={cn("text-xs", check.ok ? "text-muted-foreground" : "text-red-400")}>{check.ok ? check.detail : check.detail.split("\n").filter(Boolean).pop()}</div>
              {!check.ok && <div className="text-xs text-muted-foreground">→ {hint}</div>}
            </>
          ) : <Skeleton className="h-4 w-3/4" />}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default function OverviewPage() {
  const health = useHealth();
  const activity = useActivity(40);
  const checks = health.data?.checks;
  const stats = useStats();
  const tiles = [
    ["Total videos", stats.data?.total], ["Awaiting review", stats.data?.awaitingReview], ["Approved", stats.data?.approved],
    ["Rejected", stats.data?.rejected], ["Published", stats.data?.published], ["Failed jobs", stats.data?.failedJobs],
  ] as const;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Production status, system health and recent activity."
        actions={<Button variant="outline" size="sm" onClick={() => { void health.refetch(); void activity.refetch(); }}><RefreshCw /> Refresh</Button>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value], i) => (
          <motion.div key={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
            <Card><CardContent className="py-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
              {value === undefined ? <Skeleton className="mt-2 h-7 w-10" /> : <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>}
            </CardContent></Card>
          </motion.div>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">System health</h2>
        {health.data && <Badge variant={health.data.status === "ok" ? "secondary" : "destructive"}>{health.data.status === "ok" ? "core services up" : "degraded"}</Badge>}
      </div>
      {health.isError && <p className="mb-3 text-sm text-red-400">{errMsg(health.error)}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {SERVICES.map((s, i) => <ServiceCard key={s.key} i={i} label={s.label} icon={s.icon} hint={s.hint} check={checks?.[s.key]} />)}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="size-4" /> Recent activity</CardTitle>
          <CardDescription>Every important operation is recorded in the database. Updates live.</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.isPending && <div className="flex flex-col gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>}
          {activity.isError && <p className="text-sm text-red-400">{errMsg(activity.error)}</p>}
          {activity.data?.length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
          <ul className="flex flex-col divide-y divide-border/60">
            {activity.data?.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <div className="flex min-w-0 items-start gap-2">
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", a.level === "error" ? "bg-red-500" : a.level === "warn" ? "bg-amber-500" : "bg-primary")} />
                  <div className="min-w-0">
                    <span className="text-foreground">{a.message}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{a.entityType} · {a.action}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
