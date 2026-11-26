-- Phase 2: story understanding + permanent character profiles + prompt engine.
-- Purely additive: new enums/values, nullable or defaulted columns, two new tables. No existing row is
-- changed or deleted; existing stories get ageGroup=age_4_6, sourceMode=generated, episodeNo=1.
--   Story            ageGroup, sourceMode, sourceText (creator's verbatim text), understanding (story bible),
--                    parentStoryId/episodeNo (episode continuation)
--   StoryScene       title, location, events (story-bible events the scene shows)
--   Character        species, visualProfile (structured identity), identityPrompt, preferredModel
--   GeneratedPrompt  versioned structured prompts per scene / character view (history = older versions)
--   PromptTemplate   reusable camera / look / negatives saved from good prompts
--   StoryCategory    + panchatantra, hanuman, krishna, historical, travel_exploration, educational
--   ReferenceImageKind + front, side, back, three_quarter, closeup (multi-view character references)


-- CreateEnum
CREATE TYPE "AgeGroup" AS ENUM ('age_1_3', 'age_4_6', 'age_7_10', 'general');

-- CreateEnum
CREATE TYPE "StorySource" AS ENUM ('generated', 'idea', 'full_story', 'continuation');

-- CreateEnum
CREATE TYPE "PromptKind" AS ENUM ('scene_video', 'character_reference');

-- CreateEnum
CREATE TYPE "PromptOrigin" AS ENUM ('ai', 'ai_improved', 'ai_shortened', 'ai_expanded', 'ai_instructed', 'manual', 'model_switch', 'template', 'restored');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReferenceImageKind" ADD VALUE 'front';
ALTER TYPE "ReferenceImageKind" ADD VALUE 'side';
ALTER TYPE "ReferenceImageKind" ADD VALUE 'back';
ALTER TYPE "ReferenceImageKind" ADD VALUE 'three_quarter';
ALTER TYPE "ReferenceImageKind" ADD VALUE 'closeup';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StoryCategory" ADD VALUE 'panchatantra';
ALTER TYPE "StoryCategory" ADD VALUE 'hanuman';
ALTER TYPE "StoryCategory" ADD VALUE 'krishna';
ALTER TYPE "StoryCategory" ADD VALUE 'historical';
ALTER TYPE "StoryCategory" ADD VALUE 'travel_exploration';
ALTER TYPE "StoryCategory" ADD VALUE 'educational';

-- AlterTable
ALTER TABLE "Character" ADD COLUMN     "identityPrompt" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "preferredModel" TEXT,
ADD COLUMN     "species" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "visualProfile" JSONB;

-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "ageGroup" "AgeGroup" NOT NULL DEFAULT 'age_4_6',
ADD COLUMN     "episodeNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "parentStoryId" UUID,
ADD COLUMN     "sourceMode" "StorySource" NOT NULL DEFAULT 'generated',
ADD COLUMN     "sourceText" TEXT,
ADD COLUMN     "understanding" JSONB;

-- AlterTable
ALTER TABLE "StoryScene" ADD COLUMN     "events" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "location" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "GeneratedPrompt" (
    "id" UUID NOT NULL,
    "kind" "PromptKind" NOT NULL,
    "sceneId" UUID,
    "characterId" UUID,
    "view" TEXT NOT NULL DEFAULT '',
    "targetModel" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "origin" "PromptOrigin" NOT NULL,
    "spec" JSONB NOT NULL,
    "positive" TEXT NOT NULL,
    "negative" TEXT NOT NULL,
    "dropped" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params" JSONB,
    "evaluation" JSONB,
    "score" INTEGER,
    "instruction" TEXT,
    "model" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromptKind" NOT NULL,
    "targetModel" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "sourcePromptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedPrompt_sceneId_kind_isCurrent_idx" ON "GeneratedPrompt"("sceneId", "kind", "isCurrent");

-- CreateIndex
CREATE INDEX "GeneratedPrompt_characterId_kind_isCurrent_idx" ON "GeneratedPrompt"("characterId", "kind", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_name_key" ON "PromptTemplate"("name");

-- AddForeignKey
ALTER TABLE "Story" ADD CONSTRAINT "Story_parentStoryId_fkey" FOREIGN KEY ("parentStoryId") REFERENCES "Story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedPrompt" ADD CONSTRAINT "GeneratedPrompt_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "StoryScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedPrompt" ADD CONSTRAINT "GeneratedPrompt_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

