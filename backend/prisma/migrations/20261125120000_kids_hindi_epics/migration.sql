-- Epic story categories with their own casts
ALTER TYPE "StoryCategory" ADD VALUE 'mahabharat';
ALTER TYPE "StoryCategory" ADD VALUE 'ramayan';
ALTER TYPE "StoryCategory" ADD VALUE 'shivaji_maharaj';

-- Character: which categories it belongs to (empty = general kids' cast) and a Hindi voice
ALTER TABLE "Character" ADD COLUMN "categories" "StoryCategory"[] DEFAULT ARRAY[]::"StoryCategory"[];
ALTER TABLE "Character" ADD COLUMN "hindiVoiceProfileId" UUID;
ALTER TABLE "Character" ADD CONSTRAINT "Character_hindiVoiceProfileId_fkey" FOREIGN KEY ("hindiVoiceProfileId") REFERENCES "VoiceProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reel length (seconds)
ALTER TABLE "Story" ADD COLUMN "targetDurationSec" INTEGER;
ALTER TABLE "DailySchedule" ADD COLUMN "targetDurationSec" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "DailySchedule" ALTER COLUMN "language" SET DEFAULT 'hi';
