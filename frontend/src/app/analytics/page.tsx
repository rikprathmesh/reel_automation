"use client";

import { toast } from "sonner";
import { BarChart3, RefreshCw } from "lucide-react";
import { api, errMsg, fmtNum, CATEGORY_LABELS } from "@/lib/api";
import { useAnalytics, useApiMutation } from "@/lib/queries";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function AnalyticsPage() {
  const a = useAnalytics();
  const refresh = useApiMutation(() => api.post<{ updated: number }>("/analytics/refresh"), [["analytics"]]);
  const t = a.data?.totals;
  const maxViews = Math.max(1, ...(a.data?.top ?? []).map((r) => r.views ?? 0));

  return (
    <>
      <PageHeader title="Analytics" description="Views and engagement from YouTube and Instagram, refreshed every 6 hours."
        actions={<Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: (r) => toast.success(`Updated ${r.updated} video(s)`), onError: (e) => toast.error(errMsg(e)) })}><RefreshCw /> Refresh now</Button>} />
      {a.isError && <p className="text-sm text-red-400">{errMsg(a.error)}</p>}
      {a.isPending && <Skeleton className="h-40" />}
      {t && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Card><CardContent className="py-4"><div className="text-xs uppercase tracking-wide text-muted-foreground">Videos published</div><div className="mt-1 text-2xl font-semibold">{t.published}</div></CardContent></Card>
          {(["youtube", "instagram"] as const).map((p) => (
            <Card key={p}><CardContent className="py-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{p === "youtube" ? "YouTube Shorts" : "Instagram Reels"}</div>
              <div className="mt-1 text-2xl font-semibold">{fmtNum(t[p].views)} <span className="text-sm font-normal text-muted-foreground">views</span></div>
              <div className="text-xs text-muted-foreground">{t[p].videos} videos · {fmtNum(t[p].likes)} likes · {fmtNum(t[p].comments)} comments</div>
            </CardContent></Card>
          ))}
        </div>
      )}
      {a.data && a.data.rows.length === 0 && (
        <Card><CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground"><BarChart3 className="size-8 opacity-50" />No published videos yet. Stats appear after your first approved reel is published.</CardContent></Card>
      )}
      {a.data && a.data.top.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Top-performing stories</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {a.data.top.map((r) => (
              <div key={r.id} className="grid items-center gap-2 text-sm sm:grid-cols-[1fr_200px_80px]">
                <div className="min-w-0"><div className="truncate font-medium">{r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.title}</a> : r.title}</div><div className="text-xs text-muted-foreground">{r.platform} · {CATEGORY_LABELS[r.category]} · {new Date(r.publishedAt).toLocaleDateString()}</div></div>
                <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${((r.views ?? 0) / maxViews) * 100}%` }} /></div>
                <div className="text-right tabular-nums">{fmtNum(r.views)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
