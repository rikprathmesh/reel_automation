import type { Language, StoryCategory } from "../generated/prisma/client.ts";

export const CATEGORY_TEXT: Record<StoryCategory, string> = {
  kids_moral: "Kids' moral story — simple, warm, a clear lesson children understand (ages 4-10, but enjoyable for parents).",
  emotional: "Emotional storytelling — a moment that makes the viewer's chest tighten, then resolves with warmth.",
  motivation: "Motivation & life lesson — a small struggle, a turning point, a lesson adults can apply today.",
  rabbit_squirrel_adventure: "Rabbit & Squirrel adventure — a fun, slightly risky mini-adventure in their woodland world that ends with friendship winning.",
  friendship_kindness: "Friendship & kindness — an act of kindness that changes someone's day; kindness repaid in an unexpected way.",
  family: "Family relationships — parents, siblings or grandparents; gratitude, sacrifice, understanding.",
  funny_animals: "Funny animal story — a comic misunderstanding or mishap with great timing and a sweet ending.",
  inspirational: "Short inspirational story — someone small doing something brave; uplifting finish.",
};

export const LANGUAGE_RULES: Record<Language, string> = {
  en: "English. Simple, vivid, spoken English that sounds natural when read aloud.",
  hi: "Hindi in Devanagari script for narration and dialogue (natural spoken Hindi, not overly formal). Keep youtubeTitle, captions and hashtags in Hindi + English as is common on Indian social media. Character names stay as given.",
  hinglish: "Hinglish: conversational Hindi written in Roman script, mixed naturally with English words (e.g. \"Rabbit ne socha, 'yeh toh bahut tricky hai!'\"). Captions in Hinglish.",
};
