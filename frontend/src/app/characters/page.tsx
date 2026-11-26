"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ImagePlus, Mic, Pencil, Plus, Star, Trash2, UserRound } from "lucide-react";
import { api, errMsg, upload, CATEGORY_LABELS, EPIC_CATEGORIES, LANGUAGE_LABELS, type Character, type CharacterInput, type VoiceProfile } from "@/lib/api";
import { qk, useApiMutation, useCharacters, useSaveCharacter, useVoiceProfiles, useAvailableVoices } from "@/lib/queries";
import { PageHeader } from "@/components/page-header";
import { NativeSelect } from "@/components/native-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const EMPTY: CharacterInput = {
  name: "", description: "", appearance: "", furColors: "", clothingColors: "", personality: "", basePrompt: "", negativePrompt: "",
  expressionPresets: {}, isStoryteller: false, active: true, voiceProfileId: null, hindiVoiceProfileId: null, categories: [],
};

/** Which stories a character appears in: the general kids' cast, or one epic's own cast. */
const CAST_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "Kids' stories (Rabbit & Squirrel world)" },
  ...EPIC_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c })),
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CharacterEditor({ character, voices, onClose }: { character: Character | null; voices: VoiceProfile[]; onClose: () => void }) {
  const [form, setForm] = useState<CharacterInput>(character ? {
    name: character.name, description: character.description, appearance: character.appearance, furColors: character.furColors,
    clothingColors: character.clothingColors, personality: character.personality, basePrompt: character.basePrompt,
    negativePrompt: character.negativePrompt, expressionPresets: character.expressionPresets, isStoryteller: character.isStoryteller,
    active: character.active, voiceProfileId: character.voiceProfileId,
    hindiVoiceProfileId: character.hindiVoiceProfileId ?? null, categories: character.categories ?? [],
  } : EMPTY);
  const [presets, setPresets] = useState(Object.entries(character?.expressionPresets ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"));
  const save = useSaveCharacter();
  const set = <K extends keyof CharacterInput>(k: K, v: CharacterInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const expressionPresets = Object.fromEntries(
      presets.split("\n").map((l) => { const i = l.indexOf(":"); return i < 0 ? ["", ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }).filter(([k, v]) => k && v),
    );
    save.mutate({ id: character?.id, data: { ...form, expressionPresets } }, {
      onSuccess: () => { toast.success(character ? "Character saved" : "Character created"); onClose(); },
      onError: (e) => toast.error(errMsg(e)),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{character ? `Edit ${character.name}` : "New character"}</DialogTitle>
          <DialogDescription>Precise, stable descriptions keep the character looking the same in every scene.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Voice profile">
            <NativeSelect value={form.voiceProfileId ?? ""} onChange={(e) => set("voiceProfileId", e.target.value || null)}>
              <option value="">— none —</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.engine}: {v.voiceId})</option>)}
            </NativeSelect>
          </Field>
          <Field label="Used in" hint="Epic stories only use their own cast.">
            <NativeSelect value={form.categories[0] ?? ""} onChange={(e) => set("categories", e.target.value ? [e.target.value] : [])}>
              {CAST_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Hindi voice" hint="Used when the story is in Hindi.">
            <NativeSelect value={form.hindiVoiceProfileId ?? ""} onChange={(e) => set("hindiVoiceProfileId", e.target.value || null)}>
              <option value="">— Hindi narrator —</option>
              {voices.filter((v) => v.language === "hi").map((v) => <option key={v.id} value={v.id}>{v.name} ({v.voiceId})</option>)}
            </NativeSelect>
          </Field>
          <div className="sm:col-span-2"><Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Appearance details" hint="Body shape, eyes, ears, tail, distinctive marks."><Textarea rows={3} value={form.appearance} onChange={(e) => set("appearance", e.target.value)} /></Field></div>
          <Field label="Fur colours"><Input value={form.furColors} onChange={(e) => set("furColors", e.target.value)} /></Field>
          <Field label="Clothing colours"><Input value={form.clothingColors} onChange={(e) => set("clothingColors", e.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label="Personality"><Textarea rows={2} value={form.personality} onChange={(e) => set("personality", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Image-generation prompt" hint="Inserted into every scene prompt where this character appears."><Textarea rows={3} value={form.basePrompt} onChange={(e) => set("basePrompt", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Negative prompt"><Input value={form.negativePrompt} onChange={(e) => set("negativePrompt", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Expression presets" hint="One per line, e.g.  happy: big warm smile, eyes curved"><Textarea rows={4} value={presets} onChange={(e) => setPresets(e.target.value)} /></Field></div>
          <label className="flex items-center gap-3 text-sm"><Switch checked={form.isStoryteller} onCheckedChange={(v) => set("isStoryteller", v)} /> Main storyteller</label>
          <label className="flex items-center gap-3 text-sm"><Switch checked={form.active} onCheckedChange={(v) => set("active", v)} /> Active in new stories</label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending || !form.name || form.basePrompt.length < 10}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CharacterCard({ c, onEdit, i }: { c: Character; onEdit: () => void; i: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useApiMutation(async () => undefined, [qk.characters]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); refresh.mutate(undefined); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
      <Card className="overflow-hidden">
        <div className="relative aspect-square bg-muted/40">
          {c.primaryImageUrl
            ? <img src={c.primaryImageUrl} alt={c.name} className="size-full object-cover" />
            : <div className="grid size-full place-items-center text-muted-foreground"><div className="flex flex-col items-center gap-2 text-xs"><UserRound className="size-10 opacity-50" />No reference image yet<span className="opacity-70">Upload one, or generate a model sheet in Phase 6</span></div></div>}
          <div className="absolute top-2 left-2 flex gap-1.5">
            {c.isStoryteller && <Badge>Storyteller</Badge>}
            {c.categories?.map((k) => <Badge key={k} variant="secondary">{CATEGORY_LABELS[k] ?? k}</Badge>)}
            {!c.active && <Badge variant="secondary">Inactive</Badge>}
          </div>
        </div>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">{c.name}
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={onEdit}><Pencil /></Button>
          </CardTitle>
          <CardDescription className="line-clamp-2">{c.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="grid gap-1 text-xs text-muted-foreground">
            <div><span className="text-foreground">Fur:</span> {c.furColors || "—"}</div>
            <div><span className="text-foreground">Clothing:</span> {c.clothingColors || "—"}</div>
            <div className="flex items-center gap-1"><Mic className="size-3" /> {c.voiceProfile ? `${c.voiceProfile.name} · ${c.voiceProfile.voiceId}` : "No voice"}</div>
            <div>Used in {c.sceneCount} scene{c.sceneCount === 1 ? "" : "s"}</div>
          </div>
          {c.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {c.images.map((img) => (
                <div key={img.id} className="group relative size-14 overflow-hidden rounded-md ring-1 ring-border">
                  <img src={img.url} alt="" className="size-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center gap-0.5 bg-black/60 opacity-0 transition group-hover:opacity-100">
                    {!img.isPrimary && <button aria-label="Set primary" className="p-1" onClick={() => act(() => api.post(`/characters/${c.id}/images/${img.id}/primary`), "Primary image set")}><Star className="size-3.5" /></button>}
                    <button aria-label="Remove image" className="p-1 text-red-600 dark:text-red-400" onClick={() => act(() => api.del(`/characters/${c.id}/images/${img.id}`), "Image removed")}><Trash2 className="size-3.5" /></button>
                  </div>
                  {img.isPrimary && <Star className="absolute top-0.5 right-0.5 size-3 fill-amber-400 text-amber-700 dark:text-amber-400" />}
                </div>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void act(() => upload(`/characters/${c.id}/images`, f), "Reference image uploaded");
          }} />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}><ImagePlus /> Upload reference image</Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function VoiceProfiles({ voices }: { voices: VoiceProfile[] }) {
  const available = useAvailableVoices();
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mic className="size-4" /> Voice profiles</CardTitle>
        <CardDescription>
          Local Kokoro / Piper voices.{" "}
          {available.isError ? <span className="text-amber-700 dark:text-amber-400">Installed voices can be listed once the media service runs (Phase 6).</span> : available.data ? `${available.data.length} voices installed.` : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60 text-sm">
          {voices.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <span className="font-medium">{v.name}</span>{v.isNarrator && <Badge variant="secondary" className="ml-2">Narrator</Badge>}
                <div className="text-xs text-muted-foreground">{v.engine} · {v.voiceId} · {LANGUAGE_LABELS[v.language]} · speed {v.speed}{v.style ? ` · ${v.style}` : ""}</div>
              </div>
              <div className="text-xs text-muted-foreground">{v.characters?.length ? `Used by ${v.characters.map((c) => c.name).join(", ")}` : "Unassigned"}</div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function CharactersPage() {
  const chars = useCharacters();
  const voices = useVoiceProfiles();
  const [editing, setEditing] = useState<Character | "new" | null>(null);

  return (
    <>
      <PageHeader title="Character Studio" description="Your recurring cast. Consistent specs + reference images keep every scene on-model."
        actions={<Button onClick={() => setEditing("new")}><Plus /> New character</Button>} />
      {chars.isError && <p className="text-sm text-red-600 dark:text-red-400">{errMsg(chars.error)}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {chars.isPending && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-96" />)}
        {chars.data?.map((c, i) => <CharacterCard key={c.id} c={c} i={i} onEdit={() => setEditing(c)} />)}
      </div>
      {voices.data && <VoiceProfiles voices={voices.data} />}
      {editing && <CharacterEditor character={editing === "new" ? null : editing} voices={voices.data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}
