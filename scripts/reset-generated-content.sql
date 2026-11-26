-- =====================================================================================================
-- ReelForge: FRESH START — removes everything GENERATED so far, keeps your setup.
-- Written 2026-11-26. Run in pgAdmin on the LOCAL "PostgreSQL 18" server, database "reelforge" ONLY
-- (never on SETU_Prod or any work server). Stop the backend window FIRST.
--
-- DELETES: all stories, scripts, scenes, story bibles, scene prompts, prompt templates, reels/videos,
--          versions, scene jobs, render jobs, approvals, publishing jobs + published records + analytics,
--          schedule runs, characters the AI designed from stories (e.g. Sheru), files' database records
--          for generated media, and the activity log.
-- KEEPS:   your login (User), voice profiles, the original characters (Rabbit, Squirrel, Mahabharat /
--          Ramayan / Shivaji Maharaj casts) and their pictures, Reference Library, connected YouTube /
--          Instagram accounts, settings and the daily schedule.
--
-- "Restart identity" is not needed: every table uses random UUID ids (no number sequences to reset).
-- Everything runs in ONE transaction: if any line fails, nothing is deleted.
-- =====================================================================================================
BEGIN;

-- 1. publishing history (depends on versions and approvals)
DELETE FROM "VideoAnalytics";
DELETE FROM "PublishedVideo";
DELETE FROM "PublishingJob";
DELETE FROM "Approval";

-- 2. reels: scene jobs, versions, render jobs, projects
DELETE FROM "SceneGenerationJob";
DELETE FROM "VideoVersion";
DELETE FROM "VideoGenerationJob";
DELETE FROM "VideoProject";
DELETE FROM "ScheduleRun";

-- 3. stories, scripts, scenes and all prompts
DELETE FROM "GeneratedPrompt";
DELETE FROM "PromptTemplate";
UPDATE "StoryScene" SET "clipAssetId" = NULL;
DELETE FROM "StorySceneCharacter";
DELETE FROM "StoryScene";
DELETE FROM "StoryScript";
DELETE FROM "_StoryReferences";
DELETE FROM "Story";

-- 4. characters the AI designed from stories (identified by their creation event); the original
--    seeded characters are kept. Their reference images go with them (cascade).
DELETE FROM "Character"
WHERE id IN (SELECT "entityId"::uuid FROM "ActivityLog" WHERE action = 'created_from_story' AND "entityId" IS NOT NULL);

-- 5. kept characters: forget AI-written profiles so they are re-profiled fresh (their own identity text
--    "basePrompt", pictures and voices stay exactly as they were)
UPDATE "Character" SET "visualProfile" = NULL, "identityPrompt" = '';

-- 6. database records of generated media files (pictures, clips, voices, videos, thumbnails...).
--    Character pictures and Reference Library videos are kept.
DELETE FROM "MediaAsset"
WHERE kind IN ('scene_image', 'scene_clip', 'voice', 'video', 'thumbnail', 'subtitle', 'other', 'character_image')
  AND id NOT IN (SELECT "mediaAssetId" FROM "CharacterReferenceImage")
  AND id NOT IN (SELECT "videoAssetId" FROM "ReferenceVideo" WHERE "videoAssetId" IS NOT NULL);

-- 7. activity log (the Overview / Live log start empty)
DELETE FROM "ActivityLog";

-- check before committing: every count below should be 0
SELECT 'stories' AS what, COUNT(*) FROM "Story"
UNION ALL SELECT 'reels', COUNT(*) FROM "VideoProject"
UNION ALL SELECT 'versions', COUNT(*) FROM "VideoVersion"
UNION ALL SELECT 'prompts', COUNT(*) FROM "GeneratedPrompt"
UNION ALL SELECT 'approvals', COUNT(*) FROM "Approval";

COMMIT;

-- after COMMIT, what is left (for your information):
SELECT name, cardinality(categories) AS epic_tags FROM "Character" WHERE "deletedAt" IS NULL ORDER BY "createdAt";
