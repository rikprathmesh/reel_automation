"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BookOpen, Clapperboard, Film, ListChecks, Sparkles } from "lucide-react";
import { ago, api, errMsg, CATEGORY_LABELS, LANGUAGE_LABELS } from "@/lib/api";
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

function NewContent() {
  const [category, setCategory] = useState("rabbit_squirrel_adventure");
  const [language, setLanguage] = useState("en");
  const reel = useApiMutation((b: object) => api.post("/reels/generate", b), [["jobs"], ["projects"]]);
  const story = useApiMutation((b: object) => api.post("/stories/generate", b), [["stories"]]);
  return (
    <Card className="mb-5">
      <CardContent className="flex flex-wrap items-end gap-3 py-4">
        <div className="flex min-w-56 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Category</span>
          <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></div>
        <div className="flex w-40 flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">Language</span>
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>{Object.entries(LANGUAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></div>
        <Button disabled={reel.isPending} onClick={() => reel.mutate({ category, language }, { onSuccess: () => toast.success("New reel queued: story, then images, voice and render (about 30-50 min on this CPU)"), onError: (e) => toast.error(errMsg(e)) })}><Film /> Generate reel</Button>
        <Button variant="outline" disabled={story.isPending} onClick={() => story.mutate({ category, language }, { onSuccess: () => toast.success("Story queued (about 10 min)"), onError: (e) => toast.error(errMsg(e)) })}><Sparkles /> Story only</Button>
        <p className="w-full text-xs text-muted-foreground">Heavy AI jobs run one at a time on this machine; finished reels land in the Review Studio. Nothing is published automatically.</p>
      </CardContent>
    </Card>
  );
}

export default function ContentPage() {
  const stories = useStories();
  const projects = useProjects();
  const jobs = useJobs();
  const produce = useApiMutation((id: string) => api.post(`/stories/${id}/produce`), [["projects"], ["jobs"]]);

  return (
    <>
      <PageHeader title="Content Studio" description="Stories, scripts, video projects and generation history." />
      <NewContent />
      <Tabs defaultValue="stories">
        <TabsList className="mb-4">
          <TabsTrigger value="stories"><BookOpen /> Stories</TabsTrigger>
          <TabsTrigger value="projects"><Clapperboard /> Video projects</TabsTrigger>
          <TabsTrigger value="jobs"><ListChecks /> Generation history</TabsTrigger>
        </TabsList>

        <TabsContent value="stories">
          {stories.isPending && <Skeleton className="h-40" />}
          {stories.isError && <p className="text-sm text-red-400">{errMsg(stories.error)}</p>}
          {stories.data?.length === 0 && <Empty text="No stories yet. The story engine arrives in Phase 5." />}
          <div className="grid gap-3 md:grid-cols-2">
            {stories.data?.map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle>{s.title}</CardTitle>
                  <CardDescription>{CATEGORY_LABELS[s.category] ?? s.category} · {LANGUAGE_LABELS[s.language] ?? s.language} · {ago(s.createdAt)}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p><span className="text-foreground">Hook:</span> {s.hook}</p>
                  <p className="mt-1"><span className="text-foreground">Moral:</span> {s.moral}</p>
                  <Button size="sm" variant="outline" className="mt-3" disabled={produce.isPending} onClick={() => produce.mutate(s.id, { onSuccess: () => toast.success("Reel production queued"), onError: (e) => toast.error(errMsg(e)) })}><Film /> Produce reel</Button>
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
                    <span className={cn("text-xs", j.status === "failed" ? "text-red-400" : j.status === "completed" ? "text-emerald-400" : "text-sky-300")}>{j.status}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">{j.stage}<Progress className="h-1.5 w-16" value={j.progress} /></div>
                    <span className="text-xs text-muted-foreground">{ago(j.createdAt)}</span>
                    {j.error && <div className="text-xs text-red-400 sm:col-span-4">{j.error.message}</div>}
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
