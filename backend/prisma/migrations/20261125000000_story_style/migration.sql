-- Visual style preset per story (one style per reel)
ALTER TABLE "Story" ADD COLUMN "style" TEXT NOT NULL DEFAULT 'storybook';
