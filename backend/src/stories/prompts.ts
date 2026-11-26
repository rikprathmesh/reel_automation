import type { AgeGroup, Language, StoryCategory } from "../generated/prisma/client.ts";

/** Every reel is for children aged 1-10 (and the parents watching with them). */
export const AUDIENCE = "Children aged 1-10 and the parents watching with them.";

export const CATEGORY_TEXT: Record<StoryCategory, string> = {
  kids_moral: "Kids' moral story: a simple, warm story with one clear lesson a small child understands (sharing, honesty, patience, helping).",
  emotional: "Gentle feelings story for kids: a small sadness or worry (lost toy, missing a friend) that ends with comfort and warmth.",
  motivation: "Never-give-up story for kids: a small character tries, fails, tries again and succeeds; the lesson is effort and courage.",
  rabbit_squirrel_adventure: "Rabbit & Squirrel adventure: a fun, slightly exciting (never scary) mini-adventure in their woodland world that ends with friendship winning.",
  friendship_kindness: "Friendship & kindness: one act of kindness that makes someone's day better and comes back in a sweet, unexpected way.",
  family: "Family story for kids: parents, siblings or grandparents (dadi, nani, dada); love, gratitude and helping at home.",
  funny_animals: "Funny animal story: a silly mix-up or mishap with good comic timing and a sweet ending; laughter, never mocking.",
  inspirational: "Brave little hero story: someone small does something brave or clever; an uplifting finish.",
  panchatantra: `Panchatantra tale: retell ONE traditional Panchatantra fable (for example the monkey and the crocodile, the lion and the clever rabbit, the thirsty crow, the tortoise and the geese, the blue jackal) with its traditional animals, events and moral. Do not invent a different plot; add only small, clearly decorative details (sounds, feelings). End with the fable's own moral.`,
  educational: "Learning story: a small adventure in which the characters discover ONE true, simple fact (why it rains, how seeds grow, counting, colours, the moon's phases). The fact must be correct and stated simply; the story makes it memorable.",
  travel_exploration: "Travel & exploration story: the characters visit a real kind of place (mountains, desert, ocean, a busy Indian market, a forest at night) and discover something wonderful about it; curiosity, respect for nature, safe adventure.",
  historical: `Historical story: retell ONE real, well-documented episode or life lesson of a real historical figure (for example Swami Vivekananda, Rani Lakshmibai, APJ Abdul Kalam's childhood, Mahatma Gandhi). Keep names, places, dates and events true to the historical record; never invent facts. If you dramatize (dialogue, feelings), keep it small and plausible. Respectful, inspiring, no gore.`,
  hanuman: `Lord Hanuman story for kids: retell ONE well-known episode of Hanuman ji faithfully (for example baby Hanuman leaping for the sun, meeting Shri Ram, the leap to Lanka, finding Sita Mata in Ashok Vatika, carrying the Sanjeevani mountain, showing Ram in his heart). Keep names, places and order of events true to the Ramayan tradition; do not invent new plot. Devotional, joyful, respectful; no blood or gore. End with the lesson in one simple line.`,
  krishna: `Lord Krishna story for kids: retell ONE well-known episode of Shri Krishna faithfully (for example the butter thief of Gokul, Yashoda seeing the universe in his mouth, lifting Govardhan, taming Kaliya, friendship with Sudama, playing the flute for the cows). Keep names, places and order of events true to the tradition (Bhagavata Purana / Mahabharat); do not invent new plot. Playful, devotional, respectful. End with the lesson in one simple line.`,
  mahabharat: `Mahabharat for kids: retell ONE well-known episode from the Mahabharat faithfully (for example Arjuna aiming at the bird's eye, Krishna and Sudama's friendship, young Krishna lifting Govardhan, Eklavya's dedication, Bhima's strength, Krishna as Arjuna's charioteer).
Keep the names, places and order of events true to the traditional story; do not invent new plot. Tell it simply for children, respectfully and devotionally. Show courage, dharma, friendship and devotion; no blood or gore, battles only as brave poses and arrows in the sky. End with the lesson in one simple line.`,
  ramayan: `Ramayan for kids: retell ONE well-known episode from the Ramayan faithfully (for example Shri Ram breaking Shiva's bow, Shabari's berries, the squirrel helping build the Ram Setu, Hanuman's leap to Lanka, Hanuman carrying the Sanjeevani mountain, Ram's return to Ayodhya on Diwali).
Keep the names, places and order of events true to the traditional story; do not invent new plot. Tell it simply for children, respectfully and devotionally. Ravana may appear but never frightening; no blood or gore. End with the lesson in one simple line.`,
  shivaji_maharaj: `Chhatrapati Shivaji Maharaj for kids: retell ONE well-known, historically grounded episode (for example young Shivaji taking the oath of Swarajya at Raireshwar with Jijabai's blessing, the capture of Torna fort, Tanaji Malusare at Sinhagad, the escape from Agra in fruit baskets, Shivaji's respect for women and farmers, his coronation at Raigad).
Keep names, places and events true to history as taught to children; do not invent new plot. Tell it with pride and respect, simply for children. Show courage, cleverness, justice and love for the people; no blood or gore. Always refer to him respectfully as "Shivaji Maharaj" / "छत्रपति शिवाजी महाराज". End with the lesson in one simple line.`,
};

export const LANGUAGE_RULES: Record<Language, string> = {
  en: "English. Very simple, vivid spoken English a 5-year-old understands, natural when read aloud.",
  hi: `Hindi in Devanagari script for ALL narration and dialogue: simple, everyday spoken Hindi that a 5-year-old understands (like a dadi or nani telling a bedtime story), not formal or bookish Hindi. Short sentences.
Write the cast's names in Devanagari inside spoken lines (only names from the CAST below; never add other characters). When a cast name is an English animal or object word, use the everyday Hindi word instead of sounding it out (Rabbit → खरगोश, Squirrel → गिलहरी, Lion → शेर, Elephant → हाथी, Monkey → बंदर); proper names stay names (Sheru → शेरू). Keep the "speaker" field and the scene "characters" list exactly as the English cast names. visualPrompt stays in ENGLISH (it is an image prompt).
youtubeTitle, captions and hashtags: Hindi with a few English words, as is common on Indian kids' channels.`,
  hinglish: "Hinglish: simple conversational Hindi written in Roman script, mixed naturally with easy English words (e.g. \"Rabbit ne socha, 'yeh toh bahut tricky hai!'\"). visualPrompt stays in English. Captions in Hinglish.",
};

export interface AgeRules {
  label: string;
  audience: string;
  /** spoken words per second for narration at this age */
  wordsPerSec: number;
  language: string;
  emotion: string;
}

/** Vocabulary, pace and emotional depth per audience. */
export const AGE_RULES: Record<AgeGroup, AgeRules> = {
  age_1_3: {
    label: "1-3 years", audience: "Toddlers aged 1-3 and the parents watching with them.", wordsPerSec: 1.7,
    language: "Tiny sentences of 3-6 words. Only the most common words, lots of repetition, sound words (टप-टप, moo, whoosh), naming colours, animals and actions. One very simple event at a time.",
    emotion: "Only happy, curious and cosy feelings; a tiny surprise at most. Nothing sad or scary.",
  },
  age_4_6: {
    label: "4-6 years", audience: "Children aged 4-6 (and parents).", wordsPerSec: 2.0,
    language: "Short sentences of 5-10 words, simple everyday words, one idea per sentence, a little repetition and sound words.",
    emotion: "Simple named feelings (happy, scared, sorry, proud); a small problem that is solved kindly.",
  },
  age_7_10: {
    label: "7-10 years", audience: "Children aged 7-10.", wordsPerSec: 2.3,
    language: "Clear sentences up to 15 words, a few new interesting words explained by context, lively dialogue.",
    emotion: "Real dilemmas, mixed feelings, courage and consequences; still hopeful and never graphic.",
  },
  general: {
    label: "General audience", audience: "Families and general viewers of all ages.", wordsPerSec: 2.5,
    language: "Natural, vivid spoken language; varied sentence length; dialogue that sounds like real people.",
    emotion: "Full emotional range with depth and nuance; respectful and suitable for family viewing.",
  },
};

/** System prompt for the story writer, adapted to the audience's age. */
export function storytellerSystem(age: AgeGroup): string {
  const r = AGE_RULES[age];
  return `You are a much-loved storyteller and animation writer creating short animated story videos for YouTube and Instagram. Audience: ${r.audience}
Language level: ${r.language}
Emotional depth: ${r.emotion}
${STORYTELLER_CRAFT}`;
}

const STORYTELLER_CRAFT = `How you tell stories:
- A clear beginning (who, where), a middle (a problem), and an ending (how it is solved), in that order. No confusing jumps.
- The Narrator is the storyteller: warm and expressive, talking to the viewer ("पता है फिर क्या हुआ?" / "Guess what happened next?"). The Narrator carries the story; characters add short, lively lines.
- Characters say how they feel; use sound words, a small surprise and gentle humour where it fits.
- Never gory, cruel or mean. No blood, no weapons hurting anyone, no bad words.
- End with the moral said simply in one line by the Narrator.
- The very first spoken line is a hook that makes the viewer curious (a question or a surprise, max 12 words), never a scene description.
- Each scene is one short animated shot. Its visualPrompt is in English and describes a bright, colourful animated scene (who, doing what, where, time of day), never "realistic" or "cinematic photo".`;

/** System prompt for the story writer: a children's storyteller, not a viral-content writer. (legacy, = age 1-10) */
export const STORYTELLER_SYSTEM = `You are a much-loved children's storyteller and animation writer, like a warm grandparent telling a bedtime story, writing short animated story videos for kids aged 1-10 on YouTube and Instagram.
How you tell stories:
- Very simple words and short sentences; one idea per sentence. A 4-year-old must follow it, a 9-year-old must still enjoy it.
- A clear beginning (who, where), a middle (a small problem), and an ending (how it is solved), in that order. No confusing jumps.
- The Narrator is the storyteller: warm, gentle, expressive, talking to the child ("पता है फिर क्या हुआ?" / "Guess what happened next?"). The Narrator carries the story; characters add short, lively lines.
- Kids love: sound words (टप-टप, धम्म, whoosh), a little repetition, a small surprise, gentle humour, and characters saying how they feel.
- Never scary, violent, sad without comfort, or mean. No blood, no weapons hurting anyone, no bad words.
- End with the moral said simply in one line by the Narrator, and a happy, cosy finish.
- The very first spoken line is a hook that makes a child curious (a question or a surprise, max 12 words), never a scene description.
- Each scene is one vertical cartoon picture. Its visualPrompt is in English and describes a bright, colourful, cute cartoon scene (who, doing what, where, time of day), never "realistic" or "cinematic photo".`;
