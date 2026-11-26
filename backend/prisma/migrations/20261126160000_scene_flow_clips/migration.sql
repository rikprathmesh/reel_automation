-- Flow-assisted mode: a scene can carry a clip made in Google Flow / Veo and uploaded by the owner. Additive: one
-- nullable column on StoryScene (SET NULL if the media asset is removed). No existing row is changed.


-- AlterTable
ALTER TABLE "StoryScene" ADD COLUMN     "clipAssetId" UUID;

-- AddForeignKey
ALTER TABLE "StoryScene" ADD CONSTRAINT "StoryScene_clipAssetId_fkey" FOREIGN KEY ("clipAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

