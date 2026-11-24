/** Pure helpers (no Nest/Prisma imports) so they are unit-testable. */
export const CATEGORIES = ["kids_moral", "emotional", "motivation", "rabbit_squirrel_adventure", "friendship_kindness", "family", "funny_animals", "inspirational"] as const;

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
