-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "ReferenceSource" AS ENUM ('url', 'upload');

-- CreateEnum
CREATE TYPE "ReferenceStatus" AS ENUM ('queued', 'extracting', 'extracted', 'analyzing', 'analyzed', 'needs_upload', 'failed');

-- CreateEnum
CREATE TYPE "StoryCategory" AS ENUM ('kids_moral', 'emotional', 'motivation', 'rabbit_squirrel_adventure', 'friendship_kindness', 'family', 'funny_animals', 'inspirational');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'hi', 'hinglish');

-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('draft', 'scripted', 'in_production', 'archived');

-- CreateEnum
CREATE TYPE "ReferenceImageKind" AS ENUM ('sheet', 'pose', 'expression', 'uploaded');

-- CreateEnum
CREATE TYPE "VoiceEngine" AS ENUM ('kokoro', 'piper');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('reference_video', 'reference_frame', 'character_image', 'scene_image', 'scene_clip', 'voice', 'music', 'sfx', 'subtitle', 'video', 'thumbnail', 'other');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('queued', 'generating', 'awaiting_review', 'approved', 'rejected', 'changes_requested', 'publishing', 'published', 'failed');

-- CreateEnum
CREATE TYPE "GenerationStage" AS ENUM ('story', 'storyboard', 'voice', 'animation', 'audio', 'editing', 'render', 'validation');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'active', 'retrying', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('rendering', 'ready', 'approved', 'rejected', 'changes_requested', 'superseded', 'failed');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('approved', 'rejected', 'changes_requested');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('youtube', 'instagram');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('connected', 'expired', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('scheduled', 'queued', 'uploading', 'published', 'failed', 'cancelled', 'manual_required');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('info', 'warn', 'error');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceVideo" (
    "id" UUID NOT NULL,
    "url" TEXT,
    "platform" TEXT NOT NULL,
    "source" "ReferenceSource" NOT NULL,
    "status" "ReferenceStatus" NOT NULL DEFAULT 'queued',
    "category" "StoryCategory",
    "title" TEXT,
    "author" TEXT,
    "caption" TEXT,
    "transcript" TEXT,
    "durationSec" DOUBLE PRECISION,
    "metadata" JSONB,
    "extractor" TEXT,
    "error" TEXT,
    "thumbnailKey" TEXT,
    "videoAssetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ReferenceVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceAnalysis" (
    "id" UUID NOT NULL,
    "referenceId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "hook" JSONB NOT NULL,
    "structure" JSONB NOT NULL,
    "pacing" JSONB NOT NULL,
    "transitions" JSONB NOT NULL,
    "visualStyle" JSONB NOT NULL,
    "characterTraits" JSONB NOT NULL,
    "narration" JSONB NOT NULL,
    "emotionalArc" TEXT NOT NULL,
    "retentionTactics" TEXT[],
    "doNotCopy" TEXT[],
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Story" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "StoryCategory" NOT NULL,
    "language" "Language" NOT NULL DEFAULT 'en',
    "targetAudience" TEXT NOT NULL,
    "emotionalObjective" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "moral" TEXT NOT NULL,
    "conceptFingerprint" TEXT NOT NULL,
    "status" "StoryStatus" NOT NULL DEFAULT 'draft',
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryScript" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "narration" TEXT NOT NULL,
    "musicDirection" TEXT NOT NULL,
    "voiceInstructions" TEXT NOT NULL,
    "ending" TEXT NOT NULL,
    "youtubeTitle" TEXT NOT NULL,
    "youtubeDescription" TEXT NOT NULL,
    "instagramCaption" TEXT NOT NULL,
    "hashtags" TEXT[],
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryScene" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "visualPrompt" TEXT NOT NULL,
    "camera" TEXT NOT NULL,
    "transition" TEXT NOT NULL,
    "sfx" TEXT NOT NULL,
    "onScreenText" TEXT NOT NULL,
    "dialogue" JSONB NOT NULL,
    "durationHint" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorySceneCharacter" (
    "sceneId" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "expressionPreset" TEXT,

    CONSTRAINT "StorySceneCharacter_pkey" PRIMARY KEY ("sceneId","characterId")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "appearance" TEXT NOT NULL,
    "furColors" TEXT NOT NULL,
    "clothingColors" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "basePrompt" TEXT NOT NULL,
    "negativePrompt" TEXT NOT NULL DEFAULT '',
    "seed" INTEGER NOT NULL,
    "expressionPresets" JSONB NOT NULL DEFAULT '{}',
    "isStoryteller" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "voiceProfileId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterReferenceImage" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "kind" "ReferenceImageKind" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CharacterReferenceImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "engine" "VoiceEngine" NOT NULL,
    "voiceId" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "style" TEXT NOT NULL DEFAULT '',
    "isNarrator" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "provider" TEXT,
    "meta" JSONB,
    "projectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoProject" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "scheduleRunId" UUID,
    "status" "ProjectStatus" NOT NULL DEFAULT 'queued',
    "targetPlatforms" "Platform"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VideoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoGenerationJob" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "bullJobId" TEXT NOT NULL,
    "stage" "GenerationStage" NOT NULL DEFAULT 'story',
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "scriptId" UUID NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'rendering',
    "videoAssetId" UUID,
    "thumbnailAssetId" UUID,
    "durationSec" DOUBLE PRECISION,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "userId" UUID NOT NULL,
    "platforms" "Platform"[],
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingAccount" (
    "id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "encryptedTokens" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "AccountStatus" NOT NULL DEFAULT 'connected',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "accountId" UUID,
    "platform" "Platform" NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'queued',
    "scheduledFor" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "bullJobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedVideo" (
    "id" UUID NOT NULL,
    "publishingJobId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "remoteId" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishedVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAnalytics" (
    "id" UUID NOT NULL,
    "publishedVideoId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "reach" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySchedule" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targetCount" INTEGER NOT NULL DEFAULT 5,
    "startTime" TEXT NOT NULL DEFAULT '01:00',
    "timezone" TEXT NOT NULL,
    "categories" "StoryCategory"[],
    "language" "Language" NOT NULL DEFAULT 'en',
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRun" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "runDate" TEXT NOT NULL,
    "planned" INTEGER NOT NULL,
    "produced" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_StoryReferences" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StoryReferences_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ReferenceVideo_status_idx" ON "ReferenceVideo"("status");

-- CreateIndex
CREATE INDEX "ReferenceVideo_category_idx" ON "ReferenceVideo"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceAnalysis_referenceId_key" ON "ReferenceAnalysis"("referenceId");

-- CreateIndex
CREATE INDEX "Story_category_createdAt_idx" ON "Story"("category", "createdAt");

-- CreateIndex
CREATE INDEX "Story_conceptFingerprint_idx" ON "Story"("conceptFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "StoryScript_storyId_version_key" ON "StoryScript"("storyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "StoryScene_scriptId_index_key" ON "StoryScene"("scriptId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Character_name_key" ON "Character"("name");

-- CreateIndex
CREATE INDEX "CharacterReferenceImage_characterId_idx" ON "CharacterReferenceImage"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProfile_name_key" ON "VoiceProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_projectId_kind_idx" ON "MediaAsset"("projectId", "kind");

-- CreateIndex
CREATE INDEX "VideoProject_status_idx" ON "VideoProject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoGenerationJob_bullJobId_key" ON "VideoGenerationJob"("bullJobId");

-- CreateIndex
CREATE INDEX "VideoGenerationJob_projectId_idx" ON "VideoGenerationJob"("projectId");

-- CreateIndex
CREATE INDEX "VideoGenerationJob_status_idx" ON "VideoGenerationJob"("status");

-- CreateIndex
CREATE INDEX "VideoVersion_status_idx" ON "VideoVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoVersion_projectId_versionNo_key" ON "VideoVersion"("projectId", "versionNo");

-- CreateIndex
CREATE INDEX "Approval_versionId_decidedAt_idx" ON "Approval"("versionId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingAccount_platform_key" ON "PublishingAccount"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_idempotencyKey_key" ON "PublishingJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishingJob_status_scheduledFor_idx" ON "PublishingJob"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_versionId_platform_key" ON "PublishingJob"("versionId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedVideo_publishingJobId_key" ON "PublishedVideo"("publishingJobId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedVideo_platform_remoteId_key" ON "PublishedVideo"("platform", "remoteId");

-- CreateIndex
CREATE INDEX "VideoAnalytics_publishedVideoId_capturedAt_idx" ON "VideoAnalytics"("publishedVideoId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleRun_scheduleId_runDate_key" ON "ScheduleRun"("scheduleId", "runDate");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_idx" ON "ActivityLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "_StoryReferences_B_index" ON "_StoryReferences"("B");

-- AddForeignKey
ALTER TABLE "ReferenceVideo" ADD CONSTRAINT "ReferenceVideo_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceAnalysis" ADD CONSTRAINT "ReferenceAnalysis_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "ReferenceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryScript" ADD CONSTRAINT "StoryScript_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryScene" ADD CONSTRAINT "StoryScene_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "StoryScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorySceneCharacter" ADD CONSTRAINT "StorySceneCharacter_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "StoryScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorySceneCharacter" ADD CONSTRAINT "StorySceneCharacter_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "VoiceProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterReferenceImage" ADD CONSTRAINT "CharacterReferenceImage_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterReferenceImage" ADD CONSTRAINT "CharacterReferenceImage_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "ScheduleRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoGenerationJob" ADD CONSTRAINT "VideoGenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoVersion" ADD CONSTRAINT "VideoVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoVersion" ADD CONSTRAINT "VideoVersion_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "StoryScript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoVersion" ADD CONSTRAINT "VideoVersion_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoVersion" ADD CONSTRAINT "VideoVersion_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VideoVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "VideoVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PublishingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedVideo" ADD CONSTRAINT "PublishedVideo_publishingJobId_fkey" FOREIGN KEY ("publishingJobId") REFERENCES "PublishingJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAnalytics" ADD CONSTRAINT "VideoAnalytics_publishedVideoId_fkey" FOREIGN KEY ("publishedVideoId") REFERENCES "PublishedVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRun" ADD CONSTRAINT "ScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "DailySchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StoryReferences" ADD CONSTRAINT "_StoryReferences_A_fkey" FOREIGN KEY ("A") REFERENCES "ReferenceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StoryReferences" ADD CONSTRAINT "_StoryReferences_B_fkey" FOREIGN KEY ("B") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

