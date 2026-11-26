import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertKey } from "../src/storage/storage.types.ts";
import { LocalStorage } from "../src/storage/local.storage.ts";
import { encryptJson, decryptJson } from "../src/common/crypto.ts";
import { sniffUpload } from "../src/common/upload.ts";
import { detectPlatform } from "../src/references/platform.ts";

test("assertKey accepts normal keys and normalizes backslashes", () => {
  assert.equal(assertKey("projects/a/v1/reel.mp4"), "projects/a/v1/reel.mp4");
  assert.equal(assertKey("projects\\a\\x.png"), "projects/a/x.png");
});

test("assertKey rejects traversal, absolute and drive paths", () => {
  for (const bad of ["../.env", "a/../../b", "", "a//b", "C:/Windows/x", "./a", "a/./b"]) {
    assert.throws(() => assertKey(bad), /Invalid storage key/, bad);
  }
});

test("LocalStorage round-trips data and refuses to escape its root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-store-"));
  const s = new LocalStorage(root);
  await s.put("x/y/file.txt", Buffer.from("hello"));
  assert.equal((await s.read("x/y/file.txt")).toString(), "hello");
  assert.equal((await s.stat("x/y/file.txt"))?.size, 5);
  assert.equal(await s.stat("missing.txt"), null);
  assert.throws(() => s.localPath("../outside.txt"));
  await s.deletePrefix("x");
  assert.equal(await s.stat("x/y/file.txt"), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("token encryption round-trips and detects tampering / wrong key", () => {
  const secret = "k".repeat(40);
  const payload = { access_token: "abc", refresh_token: "def" };
  const enc = encryptJson(secret, payload);
  assert.ok(!enc.includes("abc"), "ciphertext must not contain plaintext");
  assert.deepEqual(decryptJson(secret, enc), payload);
  const buf = Buffer.from(enc, "base64");
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decryptJson(secret, buf.toString("base64")));
  assert.throws(() => decryptJson("z".repeat(40), enc));
});

function tmpFile(bytes: Buffer): Express.Multer.File {
  const p = path.join(os.tmpdir(), `rf-up-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, bytes);
  return { path: p, size: bytes.length } as Express.Multer.File;
}

test("sniffUpload accepts real MP4/PNG signatures and rejects disguised files", () => {
  const mp4 = tmpFile(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(8)]));
  assert.equal(sniffUpload(mp4, "video", 10).ext, "mp4");
  const png = tmpFile(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));
  assert.equal(sniffUpload(png, "image", 10).ext, "png");
  const fake = tmpFile(Buffer.from("<html>not a video</html>"));
  assert.throws(() => sniffUpload(fake, "video", 10), /Unsupported video/);
  assert.equal(fs.existsSync(fake.path), false, "rejected temp file must be deleted");
  assert.throws(() => sniffUpload(png, "video", 10), /Unsupported video/, "an image is not a video");
  assert.throws(() => sniffUpload(undefined, "video", 10), /No file uploaded/);
});

test("detectPlatform identifies platforms by exact host, not substring tricks", () => {
  assert.equal(detectPlatform("https://www.instagram.com/reel/DftGGw3NNDM/"), "instagram");
  assert.equal(detectPlatform("https://youtu.be/abc"), "youtube");
  assert.equal(detectPlatform("https://www.youtube.com/shorts/abc"), "youtube");
  assert.equal(detectPlatform("https://instagram.com.evil.example/reel/x"), "web");
  assert.equal(detectPlatform("not a url"), "unknown");
});

test("storyPlan: reels are at least a minute and scale scenes/tokens with length", async () => {
  const { storyPlan, normalizeLength } = await import("../src/common/lengths.ts");
  assert.equal(storyPlan(30).targetSec, 60);
  assert.equal(storyPlan(undefined).targetSec, 60);
  assert.equal(storyPlan(999).targetSec, 180);
  const short = storyPlan(60), long = storyPlan(180);
  assert.ok(long.minScenes > short.minScenes && long.words > short.words && long.maxTokens > short.maxTokens);
  assert.ok(long.maxTokens + 4096 <= 16384, "long reels must fit the Ollama context cap");
  assert.equal(normalizeLength(90), 60);
  assert.equal(normalizeLength(100), 120);
  assert.equal(normalizeLength(170), 180);
});
