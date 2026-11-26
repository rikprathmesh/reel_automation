"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api, ApiError, type ActivityEntry, type Character, type CharacterInput, type GenerationJob, type GenerationSettings, type DailySchedule,
  type Health, type Integration, type ReviewVersion, type PublishingJobRow, type AccountsPayload, type AnalyticsPayload, type ProjectSummary, type Reference, type SessionUser, type SettingsPayload, type Stats, type Story, type VoiceProfile,
} from "./api";

/** Central query keys so live events can invalidate exactly what changed. */
export const qk = {
  session: ["session"] as const,
  health: ["health"] as const,
  activity: (limit: number) => ["activity", limit] as const,
  stats: ["stats"] as const,
  characters: ["characters"] as const,
  voices: ["voice-profiles"] as const,
  availableVoices: ["voice-profiles", "available"] as const,
  references: ["references"] as const,
  reference: (id: string) => ["references", id] as const,
  stories: ["stories"] as const,
  projects: ["projects"] as const,
  jobs: ["jobs"] as const,
  integrations: ["integrations"] as const,
  settings: ["settings"] as const,
  review: (status: string) => ["review", status] as const,
  publishing: ["publishing"] as const,
  accounts: ["publishing", "accounts"] as const,
  analytics: ["analytics"] as const,
};

/** Current user, or null when signed out. Backend-down errors propagate so the UI can say so. */
export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: async () => {
      try {
        return (await api.get<{ user: SessionUser }>("/auth/me")).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.post<{ user: SessionUser }>("/auth/login", v),
    onSuccess: (r) => qc.setQueryData(qk.session, r.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      qc.setQueryData(qk.session, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    },
  });
}

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: () => api.get<Health>("/health"), refetchInterval: 15_000 });
}

export function useActivity(limit = 50) {
  return useQuery({ queryKey: qk.activity(limit), queryFn: () => api.get<ActivityEntry[]>(`/activity?limit=${limit}`) });
}

/**
 * Subscribes to the backend's Server-Sent Events and refreshes affected data.
 * EventSource reconnects automatically (the server sends `retry: 3000`).
 */
export function useLiveEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/api/events");
    const on = (type: string, keys: readonly (readonly string[])[]) =>
      es.addEventListener(type, () => keys.forEach((k) => void qc.invalidateQueries({ queryKey: k })));
    on("activity", [["activity"]]);
    on("reference", [qk.references]);
    on("character", [qk.characters, ["prompts"]]);
    on("story", [qk.stories, qk.stats, ["prompts"]]);
    on("project", [qk.projects, qk.stats, ["review"]]);
    on("job", [qk.jobs, qk.projects, qk.stats]);
    on("publishing", [qk.projects, qk.stats, qk.publishing, ["review"]]);
    return () => es.close();
  }, [enabled, qc]);
}

/* ----------------------------- domain queries ----------------------------- */

export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: () => api.get<Stats>("/stats") });
export const useCharacters = () => useQuery({ queryKey: qk.characters, queryFn: () => api.get<Character[]>("/characters") });
export const useVoiceProfiles = () => useQuery({ queryKey: qk.voices, queryFn: () => api.get<VoiceProfile[]>("/voice-profiles") });
export const useAvailableVoices = () =>
  useQuery({ queryKey: qk.availableVoices, queryFn: () => api.get<{ engine: string; id: string; name: string; language: string }[]>("/voice-profiles/available"), retry: false });
export const useReferences = () =>
  useQuery({ queryKey: qk.references, queryFn: () => api.get<Reference[]>("/references"), refetchInterval: (q) => (q.state.data?.some((r) => !["analyzed", "failed", "needs_upload"].includes(r.status)) ? 5000 : false) });
export const useReference = (id: string | null) => useQuery({ queryKey: qk.reference(id ?? ""), queryFn: () => api.get<Reference>(`/references/${id}`), enabled: Boolean(id) });
export const useStories = () => useQuery({ queryKey: qk.stories, queryFn: () => api.get<Story[]>("/stories") });
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api.get<ProjectSummary[]>("/projects") });
export const useJobs = () => useQuery({ queryKey: qk.jobs, queryFn: () => api.get<GenerationJob[]>("/jobs") });
export const useIntegrations = () => useQuery({ queryKey: qk.integrations, queryFn: () => api.get<Integration[]>("/integrations") });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => api.get<SettingsPayload>("/settings") });

/** Generic mutation that invalidates the given keys on success. */
export function useApiMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly (readonly string[])[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => invalidate.forEach((k) => void qc.invalidateQueries({ queryKey: k })),
  });
}

export const useSaveCharacter = () =>
  useApiMutation((v: { id?: string; data: CharacterInput }) => (v.id ? api.put(`/characters/${v.id}`, v.data) : api.post("/characters", v.data)), [qk.characters]);
export const useSaveGeneration = () => useApiMutation((v: GenerationSettings) => api.put("/settings/generation", v), [qk.settings]);
export const useSaveSchedule = () => useApiMutation((v: Omit<DailySchedule, "id">) => api.put("/settings/schedule", v), [qk.settings]);

export const useReview = (status: string) => useQuery({ queryKey: qk.review(status), queryFn: () => api.get<ReviewVersion[]>(`/review?status=${status}`) });
export const usePublishing = () => useQuery({ queryKey: qk.publishing, queryFn: () => api.get<PublishingJobRow[]>("/publishing"), refetchInterval: 15_000 });
export const useAccounts = () => useQuery({ queryKey: qk.accounts, queryFn: () => api.get<AccountsPayload>("/publishing/accounts") });
export const useAnalytics = () => useQuery({ queryKey: qk.analytics, queryFn: () => api.get<AnalyticsPayload>("/analytics") });
