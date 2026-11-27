import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGate, type GateFacts } from "../src/publishing/gate.ts";
import { storyProblems, fingerprint, similarity, type StoryData } from "../src/stories/story.schema.ts";

const t0 = new Date("2026-11-24T10:00:00Z");
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    job: { status: "queued", platform: "youtube", approvalId: "a1", alreadyPublished: false },
    version: { status: "approved" },
    projectDeleted: false,
    decisions: [{ id: "a1", decision: "approved", platforms: ["youtube", "instagram"], decidedAt: t0 }],
    ...over,
  };
}

test("gate: an approved version with a matching approval may publish", () => {
  assert.deepEqual(checkGate(facts()), { ok: true });
});

test("gate: a REJECTED version can never publish", () => {
  const r = checkGate(facts({ version: { status: "rejected" }, decisions: [
    { id: "a1", decision: "approved", platforms: ["youtube"], decidedAt: t0 },
    { id: "r1", decision: "rejected", platforms: [], decidedAt: later(5) },
  ] }));
  assert.equal(r.ok, false);
});

test("gate: rejected after approval blocks even if the version row still says approved", () => {
  const r = checkGate(facts({ decisions: [
    { id: "a1", decision: "approved", platforms: ["youtube"], decidedAt: t0 },
    { id: "r1", decision: "rejected", platforms: [], decidedAt: later(1) },
  ] }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /rejected/);
});

test("gate: changes requested after approval blocks", () => {
  const r = checkGate(facts({ decisions: [
    { id: "a1", decision: "approved", platforms: ["youtube"], decidedAt: t0 },
    { id: "c1", decision: "changes_requested", platforms: [], decidedAt: later(2) },
  ] }));
  assert.equal(r.ok, false);
});

test("gate: no decision at all blocks (frontend state is never trusted)", () => {
  const r = checkGate(facts({ decisions: [] }));
  assert.equal(r.ok, false);
});

test("gate: version merely 'ready' (not approved) blocks", () => {
  assert.equal(checkGate(facts({ version: { status: "ready" } })).ok, false);
});

test("gate: approval for another platform does not cover this one", () => {
  const r = checkGate(facts({ job: { status: "queued", platform: "instagram", approvalId: "a1", alreadyPublished: false }, decisions: [{ id: "a1", decision: "approved", platforms: ["youtube"], decidedAt: t0 }] }));
  assert.equal(r.ok, false);
});

test("gate: job linked to a non-existent approval blocks", () => {
  assert.equal(checkGate(facts({ job: { status: "queued", platform: "youtube", approvalId: "forged", alreadyPublished: false } })).ok, false);
});

test("gate: deleted project blocks", () => {
  assert.equal(checkGate(facts({ projectDeleted: true })).ok, false);
});

test("gate: cancelled / uploading / failed jobs are not re-published", () => {
  for (const status of ["cancelled", "uploading", "failed", "published", "manual_required"]) {
    assert.equal(checkGate(facts({ job: { status, platform: "youtube", approvalId: "a1", alreadyPublished: false } })).ok, false, status);
  }
});

test("gate: already-published jobs are skipped (no duplicate upload on retry)", () => {
  const r = checkGate(facts({ job: { status: "queued", platform: "youtube", approvalId: "a1", alreadyPublished: true } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.skip, true);
});

test("gate: re-approval after a change request (new approval) is allowed", () => {
  const r = checkGate(facts({ job: { status: "queued", platform: "youtube", approvalId: "a2", alreadyPublished: false }, decisions: [
    { id: "a1", decision: "approved", platforms: ["youtube"], decidedAt: t0 },
    { id: "c1", decision: "changes_requested", platforms: [], decidedAt: later(1) },
    { id: "a2", decision: "approved", platforms: ["youtube"], decidedAt: later(2) },
  ] }));
  assert.deepEqual(r, { ok: true });
});

const scene = (lines: { speaker: string; text: string }[]) => ({
  description: "d", visualPrompt: "v", characters: ["Rabbit"], expressions: ["happy"], camera: "static" as const, transition: "fade" as const,
  dialogue: lines.map((l) => ({ ...l, emotion: "warm" })), sfx: "", onScreenText: "", durationHint: 5,
});
const story = (over: Partial<StoryData> = {}): StoryData => ({
  title: "T", targetAudience: "kids", emotionalObjective: "joy", hook: "Can a tiny rabbit outsmart a storm?", premise: "p",
  narration: "", voiceInstructions: "", musicDirection: "", ending: "", moral: "m", youtubeTitle: "y", youtubeDescription: "", instagramCaption: "", hashtags: [],
  scenes: Array.from({ length: 6 }, (_, i) => scene(i === 0
    ? [{ speaker: "Narrator", text: "Can a tiny rabbit outsmart a storm? The clouds rolled in fast over the meadow today." }]
    : [{ speaker: "Narrator", text: "The wind howled across the meadow as the friends raced home together through the tall grass." }, { speaker: "Rabbit", text: "Hold my paw, we can do this together!" }])),
  ...over,
});

test("story gate: a full draft with a spoken hook passes", () => {
  assert.deepEqual(storyProblems(story(), 130), []);
});

test("story gate: a script far over the reel's word budget is flagged as too long", () => {
  // 136 spoken words for a reel with room for 100 (a 60 s reel came out 137 s this way)
  assert.ok(storyProblems(story(), 100).some((x) => /too long/i.test(x)));
});

test("story gate: a descriptive hook, too few words and no narrator are rejected", () => {
  const p = storyProblems(story({ hook: "The scene opens with Rabbit sitting on a stump", scenes: Array.from({ length: 6 }, () => scene([{ speaker: "Rabbit", text: "Hi." }])) }), 100);
  assert.ok(p.some((x) => /too short/i.test(x)));
  assert.ok(p.some((x) => /Narrator/.test(x)));
  assert.ok(p.some((x) => /description/.test(x)));
});

test("duplicate detection: near-identical concepts score high, different ones low", () => {
  const a = fingerprint({ title: "Rabbit and Squirrel's Friendship Test", premise: "Two friends trust each other in a dark cave", moral: "Trust makes friends brave" });
  const b = fingerprint({ title: "The Friendship Test of Rabbit and Squirrel", premise: "Friends trust each other inside a dark cave", moral: "Trust makes friendship brave" });
  const c = fingerprint({ title: "The Lost Kite", premise: "A squirrel helps a lonely hedgehog fly a kite on a windy hill", moral: "Kindness lifts others up" });
  assert.ok(similarity(a, b) > 0.45);
  assert.ok(similarity(a, c) < 0.2);
});

import { InstagramClient } from "../src/publishing/instagram.client.ts";

test("instagram business login URL matches Meta's documented parameters", () => {
  const c = new InstagramClient("1577113481127120", "secret", "v27.0", "http://localhost:3000/settings/instagram-callback");
  const u = new URL(c.authUrl("0123456789abcdef0123456789abcdef"));
  assert.equal(u.origin + u.pathname, "https://www.facebook.com/v27.0/dialog/oauth");
  assert.equal(u.searchParams.get("display"), "page");
  assert.equal(u.searchParams.get("response_type"), "token");
  assert.deepEqual(JSON.parse(u.searchParams.get("extras")!), { setup: { channel: "IG_API_ONBOARDING" } });
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:3000/settings/instagram-callback");
  for (const s of ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "pages_show_list"]) assert.ok(u.searchParams.get("scope")!.split(",").includes(s), s);
  assert.equal(u.searchParams.get("state"), "0123456789abcdef0123456789abcdef");
});
