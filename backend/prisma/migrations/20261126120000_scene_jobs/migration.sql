-- Async scene pipeline: one SceneGenerationJob per scene of each render (keyframe image, voices, optional AI clip),
-- merged by a per-version merge job. Purely additive: a new enum, a new table, and a nullable VideoVersion.timings
-- column (wall-clock timings of each render). No existing row is changed.


-- CreateEnum
CREATE TYPE "SceneJobStatus" AS ENUM ('queued', 'active', 'completed', 'failed');

-- AlterTable
ALTER TABLE "VideoVersion" ADD COLUMN     "timings" JSONB;

-- CreateTable
CREATE TABLE "SceneGenerationJob" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "sceneId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "status" "SceneJobStatus" NOT NULL DEFAULT 'queued',
    "bullJobId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "seed" INTEGER NOT NULL,
    "imageKey" TEXT,
    "clipKey" TEXT,
    "voices" JSONB,
    "promptId" UUID,
    "promptVersion" INTEGER,
    "reusedFromId" UUID,
    "error" JSONB,
    "timings" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SceneGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SceneGenerationJob_versionId_status_idx" ON "SceneGenerationJob"("versionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SceneGenerationJob_versionId_sceneId_key" ON "SceneGenerationJob"("versionId", "sceneId");

-- AddForeignKey
ALTER TABLE "SceneGenerationJob" ADD CONSTRAINT "SceneGenerationJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VideoVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneGenerationJob" ADD CONSTRAINT "SceneGenerationJob_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "StoryScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

