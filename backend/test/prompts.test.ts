import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, renderPrompt } from "../src/prompts/adapters.ts";
import { assembleSceneSpec, identityTags, referenceViewSpecs, type CastEntry } from "../src/prompts/assemble.ts";
import { evaluateScene, sceneFingerprint } from "../src/prompts/evaluate.ts";
import type { CharacterProfile, SceneDraft } from "../src/prompts/spec.ts";
import { faithfulnessProblems, type StoryBible } from "../src/stories/understanding.ts";
import { storyPlan } from "../src/common/lengths.ts";

const profile: CharacterProfile = {
  species: "lion cub", ageAppearance: "baby", bodyProportions: "small round body, big head", face: "round cute face, short muzzle",
  eyeColor: "big amber", surface: "golden fluffy fur", clothing: "none", accessories: ["red scarf around the neck"],
  permanentColors: ["golden", "amber", "red"], silhouette: "rounded ears, tufted tail", personality: "curious", motionStyle: "bouncy steps",
  expressions: [{ name: "curious", look: "head tilted, wide eyes" }, { name: "happy", look: "big open smile" }],
  voice: { gender: "male", age: "child", tone: "bright" },
};

const cast = (name: string, identity: string, ref: string | null): CastEntry => ({
  id: name, name, identity, clothing: "", accessories: [], permanentColors: [], negative: "", referenceKey: ref, referenceUrl: null, voice: "Boy (EN)", expressions: {}, expression: null,
});

const draft = (over: Partial<SceneDraft> = {}): SceneDraft => ({
  keyMoment: "The lion cub stops on the jungle path and stares at a blue butterfly on a pink flower",
  environment: { location: "sunlit jungle path between giant ferns", background: "tall trees with hanging vines", timeOfDay: "morning", weather: "light breeze", objects: ["pink flower", "mossy rock", "fallen log"], details: ["leaves swaying", "sun rays through the canopy"] },
  characters: [{ name: "Cub", action: "walks slowly along the path and freezes when he sees the butterfly", movements: ["paws step softly one after another", "ears twitch toward the sound", "tail swishes slowly"], interaction: "watches the butterfly land", startPosition: "left third of the frame walking right", endPosition: "centre, sitting, face close to the flower", expression: "curious wonder", eyes: "follow the butterfly", mouth: "slightly open", head: "tilts to one side" }],
  camera: { shot: "wide", angle: "eye level", movement: "tracking", movementDetail: "starts wide, tracks beside the cub, then pushes in to a close-up on his face", focus: "background softens as the camera pushes in" },
  visual: { lighting: "warm morning sun from the upper left", atmosphere: "soft mist and floating pollen", colorGrade: "warm greens and golds", effects: ["sparkles on the butterfly wings"] },
  audio: { sfx: ["soft paw steps"], ambience: "birdsong" },
  continuity: { fromPrevious: "", toNext: "the cub follows the butterfly deeper into the jungle", props: "the pink flower stays on the right" },
  ...over,
});

const ctx = (overrides: Partial<Parameters<typeof assembleSceneSpec>[1]> = {}) => ({
  sceneIndex: 0, sceneTitle: "The butterfly", description: "The cub sees a butterfly", durationSec: 8, isFirst: true, isLast: false,
  style: { id: "storybook", label: "3D Cartoon", prompt: "3d cartoon", negative: "photo" },
  cast: [cast("Cub", identityTags(profile), "characters/cub/sheet.png")], dialogue: [{ speaker: "Narrator", text: "One morning...", emotion: "warm" }],
  ...overrides,
});

test("identityTags builds a compact, stable identity from the profile (no 'wearing none')", () => {
  const tags = identityTags(profile);
  assert.match(tags, /baby lion cub/);
  assert.match(tags, /golden fluffy fur/);
  assert.match(tags, /amber eyes/);
  assert.match(tags, /red scarf/);
  assert.doesNotMatch(tags, /wearing none/);
  assert.equal(identityTags(profile), tags, "deterministic");
});

test("assembleSceneSpec takes identity from the cast, never from the draft, and drops strangers", () => {
  const d = draft({ characters: [...draft().characters, { ...draft().characters[0]!, name: "Tiger" }] });
  const { spec, ignored } = assembleSceneSpec(d, ctx());
  assert.deepEqual(ignored, ["Tiger"]);
  assert.equal(spec.characters.length, 1);
  assert.equal(spec.characters[0]!.identity, identityTags(profile));
  assert.equal(spec.continuity.fromPrevious, "", "first scene has no previous");
  assert.ok(spec.negative.includes("character morphing"));
});

test("still adapter keeps identity + key moment and reports motion as dropped", () => {
  const { spec } = assembleSceneSpec(draft(), ctx());
  const r = renderPrompt(spec, "sd15-still");
  assert.match(r.positive, /golden fluffy fur/);
  assert.match(r.positive, /blue butterfly/);
  assert.ok(r.dropped.some((d) => /body movements, camera movement/.test(d)));
  assert.ok(r.routed.some((x) => /TTS/.test(x)));
  assert.ok(r.positive.split(/\s+/).length <= MODELS["sd15-still"]!.maxPromptWords + 40, "stays near the budget (identity is never trimmed)");
});

test("flat styles name characters instead of describing them", () => {
  const { spec } = assembleSceneSpec(draft(), ctx({ style: { id: "pinman", label: "Pinman", prompt: "stick figure", negative: "", cast: "name" } }));
  const r = renderPrompt(spec, "sd15-still");
  assert.doesNotMatch(r.positive, /golden fluffy fur/);
  assert.match(r.positive, /Cub/);
});

test("prose adapter writes a chronological paragraph with start, action and end", () => {
  const { spec } = assembleSceneSpec(draft(), ctx());
  const r = renderPrompt(spec, "wan21-i2v");
  assert.match(r.positive, /starts left third of the frame/);
  assert.match(r.positive, /By the end Cub is centre/);
  assert.match(r.positive, /Camera: starts wide/);
  assert.equal(r.params.clips, 2, "8 s scene on a 5 s model = 2 clips");
});

test("models without text control say so instead of pretending", () => {
  const { spec } = assembleSceneSpec(draft(), ctx());
  const svd = renderPrompt(spec, "svd-xt");
  assert.equal(svd.positive, "");
  assert.ok(svd.dropped.some((d) => /takes no text prompt/.test(d)));
  const kb = renderPrompt(spec, "kenburns");
  assert.equal(kb.params.kenburns, "pan_right");
  assert.equal(MODELS.kenburns!.isAiAnimation, false);
});

test("manual override replaces the rendered text", () => {
  const { spec } = assembleSceneSpec(draft(), ctx());
  spec.override = { positive: "my own prompt" };
  assert.equal(renderPrompt(spec, "animatediff-lcm").positive, "my own prompt");
});

test("evaluator rewards a complete prompt and pinpoints gaps", () => {
  const good = assembleSceneSpec(draft(), ctx()).spec;
  const eGood = evaluateScene(good, renderPrompt(good, "animatediff-lcm"), MODELS["animatediff-lcm"]!);
  assert.ok(eGood.score >= 85, `good prompt scored ${eGood.score}: ${eGood.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);

  const thin = assembleSceneSpec(draft({ characters: [{ ...draft().characters[0]!, action: "walks", movements: [], startPosition: "", endPosition: "", eyes: "", mouth: "" }], camera: { ...draft().camera, movementDetail: "" } }), ctx({ isFirst: false, sceneIndex: 2 })).spec;
  const eThin = evaluateScene(thin, renderPrompt(thin, "animatediff-lcm"), MODELS["animatediff-lcm"]!);
  assert.ok(eThin.score < eGood.score - 25);
  const failed = eThin.checks.filter((c) => !c.ok).map((c) => c.id);
  for (const id of ["actions", "movement", "positions", "camera", "continuity"]) assert.ok(failed.includes(id), `expected ${id} to fail`);
  assert.ok(eThin.fixes.length >= 4);
});

test("evaluator notes a missing reference image and identical scenes", () => {
  const spec = assembleSceneSpec(draft(), ctx({ cast: [cast("Cub", identityTags(profile), null)] })).spec;
  const e = evaluateScene(spec, renderPrompt(spec, "sd15-still"), MODELS["sd15-still"]!, [sceneFingerprint(spec)]);
  assert.equal(e.checks.find((c) => c.id === "reference")!.ok, false);
  assert.equal(e.checks.find((c) => c.id === "distinct")!.ok, false);
  assert.ok(e.notes.some((n) => /reference images for Cub/.test(n)));
});

test("reference views cover the permanent turnaround with the same identity", () => {
  const views = referenceViewSpecs("Cub", profile, { label: "3D", prompt: "3d cartoon", negative: "photo" }, "scary");
  assert.deepEqual(views.map((v) => v.view), ["front", "three_quarter", "side", "back", "closeup", "expressions"]);
  for (const v of views) assert.match(v.positive, /golden fluffy fur/);
  assert.match(views.find((v) => v.view === "expressions")!.positive, /curious: head tilted/);
});

const bible: StoryBible = {
  title: "T", logline: "L", sourceType: "user_story", sourceNotes: "",
  characters: [{ name: "Cub", role: "main", species: "lion", personality: "curious", appearance: "", relationships: [] }, { name: "Bunny", role: "supporting", species: "rabbit", personality: "shy", appearance: "", relationships: [] }],
  locations: [], objects: [],
  events: [1, 2, 3].map((order) => ({ order, summary: `event ${order}`, location: "jungle", characters: ["Cub"], emotion: "joy" })),
  conflicts: [], emotions: [], dialogueHints: [], moral: "m", beginning: "", middle: "", ending: "",
};

test("faithfulness: strangers, missing and out-of-order events are reported", () => {
  assert.deepEqual(faithfulnessProblems(bible, [{ characters: ["Cub", "Narrator"], events: [1] }, { characters: ["Bunny"], events: [2, 3] }]), []);
  const p = faithfulnessProblems(bible, [{ characters: ["Cub", "Tiger"], events: [2] }, { characters: ["Cub"], events: [1] }]);
  assert.equal(p.length, 3);
  assert.match(p[0]!, /Tiger/);
  assert.match(p[1]!, /#3/);
  assert.match(p[2]!, /out of chronological order/);
});

test("storyPlan: ~8 s scenes and the audience's speaking pace", () => {
  const p = storyPlan(60, { sceneSec: 8, wordsPerSec: 2.0 });
  assert.equal(p.words, 120);
  assert.ok(p.minScenes >= 6 && p.maxScenes <= 10, `${p.minScenes}-${p.maxScenes}`);
  assert.equal(p.linesPerScene, 2);
  const toddler = storyPlan(60, { sceneSec: 8, wordsPerSec: 1.7 });
  assert.ok(toddler.words < p.words);
  assert.equal(storyPlan(30).targetSec, 60, "never under a minute");
});

test("identityTags removes repeats a small model produces (real Sheru output, 2026-11-26)", async () => {
  const { identityTags, missingDetails } = await import("../src/prompts/assemble.ts");
  const weak: CharacterProfile = { ...profile, species: "Lion", ageAppearance: "Baby", surface: "Golden", eyeColor: "Amber", face: "Amber eyes, small rounded ears", bodyProportions: "Small", clothing: "Red scarf", accessories: [] };
  const tags = identityTags(weak);
  assert.equal(tags.match(/amber eyes/gi)?.length, 1, tags);
  assert.doesNotMatch(tags, /, Small,/, "a lone 'Small' is dropped when a longer phrase contains it");
  // the story said "golden fluffy fur": the self-check names what the design dropped
  const missing = missingDetails("golden fluffy fur, big amber eyes, small rounded ears, red scarf around his neck", tags);
  assert.ok(missing.includes("fluffy") && missing.includes("fur"), missing.join(","));
  assert.ok(!missing.includes("amber") && !missing.includes("scarf"));
});

test("cleanIdentity fixes 'wearing wears' (real Sheru output, 2026-11-26)", async () => {
  const { cleanIdentity } = await import("../src/prompts/assemble.ts");
  assert.equal(cleanIdentity("small round body, wearing wears a red scarf around his neck"), "small round body, wearing a red scarf around his neck");
});

test("Veo/Flow prompt: identity, Hindi dialogue with voices, audio is the model's, no on-screen text", () => {
  const { spec } = assembleSceneSpec(draft(), ctx({ dialogue: [{ speaker: "Narrator", text: "एक दिन शेरू जंगल में घूम रहा था।", emotion: "warm" }, { speaker: "Cub", text: "वाह! कितनी सुंदर तितली!", emotion: "excited" }] }));
  const r = renderPrompt(spec, "veo-flow");
  assert.match(r.positive, /Vertical 9:16/);
  assert.match(r.positive, /golden fluffy fur/);
  assert.match(r.positive, /Narrator \(voice-over/);
  assert.match(r.positive, /says in Hindi: "वाह! कितनी सुंदर तितली!"/);
  assert.match(r.positive, /No on-screen text, no subtitles/);
  assert.ok(r.routed.some((x) => /generated by the model/.test(x)));
  assert.ok(!r.dropped.some((x) => /lip-sync/.test(x)), "Veo does lip-sync");
  const long = assembleSceneSpec(draft(), ctx({ dialogue: [{ speaker: "Narrator", text: Array(40).fill("शब्द").join(" "), emotion: "warm" }] })).spec;
  assert.ok(renderPrompt(long, "veo-flow").dropped.some((x) => /make 2 clips/.test(x)));
});
