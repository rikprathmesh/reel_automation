/** Pure helpers (no Nest/Prisma imports) so they are unit-testable. */
export const CATEGORIES = ["kids_moral", "emotional", "motivation", "rabbit_squirrel_adventure", "friendship_kindness", "family", "funny_animals", "inspirational", "panchatantra", "educational", "travel_exploration", "historical", "mahabharat", "ramayan", "hanuman", "krishna", "shivaji_maharaj"] as const;
export type CategoryId = (typeof CATEGORIES)[number];
/** Epic categories: told with their own cast (Character.categories), never the general kids' cast. */
export const EPIC_CATEGORIES = ["mahabharat", "ramayan", "hanuman", "krishna", "shivaji_maharaj"] as const;
/** Cast tags each epic category may draw on (Hanuman stories use the Ramayan cast, Krishna stories the Mahabharat cast). */
export const CATEGORY_CASTS: Partial<Record<CategoryId, CategoryId[]>> = {
  mahabharat: ["mahabharat"], ramayan: ["ramayan"], shivaji_maharaj: ["shivaji_maharaj"],
  hanuman: ["hanuman", "ramayan"], krishna: ["krishna", "mahabharat"],
};
/** Retellings of scripture or history: source details must be preserved and never invented. */
export const SOURCE_MATERIAL_CATEGORIES: readonly CategoryId[] = ["mahabharat", "ramayan", "hanuman", "krishna", "shivaji_maharaj", "historical", "panchatantra"];

export const AGE_GROUPS = ["age_1_3", "age_4_6", "age_7_10", "general"] as const;
export type AgeGroupId = (typeof AGE_GROUPS)[number];
export const STORY_SOURCES = ["generated", "idea", "full_story", "continuation"] as const;

export function detectPlatform(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "unknown"; }
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)(facebook\.com|fb\.watch)$/.test(host)) return "facebook";
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return "x";
  return "web";
}
