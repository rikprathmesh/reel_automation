import { z } from "zod";

/**
 * Story Understanding Engine contract: the "story bible" extracted BEFORE any script or prompt is written.
 * Scene breakdown, character creation and every scene prompt read from it, so they share one understanding of
 * who is in the story, where it happens and in what order events occur.
 */
export const StoryBible = z.object({
  title: z.string(),
  logline: z.string().describe("One-sentence summary"),
  sourceType: z.enum(["original_fiction", "user_story", "traditional_mythology", "traditional_fable", "historical"]),
  sourceNotes: z.string().describe("For mythology/history/fables: the source tradition and which details must stay true. For fiction: empty"),
  characters: z.array(z.object({
    name: z.string().describe("The name used in the story (English spelling)"),
    role: z.enum(["main", "supporting", "minor"]),
    species: z.string().describe("What the character is: 'baby lion', 'rabbit', 'young prince'"),
    personality: z.string(),
    appearance: z.string().describe("Every visual detail the story gives (colours, clothing, accessories, size). Do not invent beyond the story except to make a clear cartoon design"),
    relationships: z.array(z.object({ to: z.string(), relation: z.string() })),
  })),
  locations: z.array(z.object({ name: z.string(), description: z.string(), timeOfDay: z.string(), visualDetails: z.array(z.string()) })),
  objects: z.array(z.object({ name: z.string(), description: z.string(), importance: z.string() })),
  events: z.array(z.object({
    order: z.number().int().describe("1-based chronological order"),
    summary: z.string().describe("What happens, concretely"),
    location: z.string(),
    characters: z.array(z.string()),
    emotion: z.string(),
  })).describe("Every story event in chronological order"),
  conflicts: z.array(z.string()),
  emotions: z.array(z.string()).describe("The emotional arc in order"),
  dialogueHints: z.array(z.string()).describe("Important lines or exchanges the story contains (keep the user's wording)"),
  moral: z.string(),
  beginning: z.string(),
  middle: z.string(),
  ending: z.string(),
});
export type StoryBible = z.infer<typeof StoryBible>;

export const UNDERSTANDING_SYSTEM = `You are a story editor for an animation studio. You read a story (or an idea) carefully and extract a precise story bible: every character with their personality, relationships and every visual detail given; every location; important objects; every event in chronological order; conflicts; the emotional arc; the moral; and the beginning, middle and end.
Rules:
- Stay faithful to the given text. Do not add events, characters or facts that are not there. If the input is only an idea, develop it into a complete, simple story with a clear beginning, middle and ending, and mark sourceType "original_fiction".
- For mythology, scripture, fables and history: keep names, places and the order of events true to the traditional / historical source, and write in sourceNotes which details must be preserved and what is storytelling dramatization.
- Character names: use the English spelling as the name even if the story is in Hindi (e.g. "Sheru", "Hanuman").
- Be concrete: events describe visible actions, not abstractions.`;

/** Pure faithfulness checks between a script and the bible (unit-tested). */
export function faithfulnessProblems(bible: StoryBible, scenes: { characters: string[]; events?: number[] }[], allowedExtra: string[] = ["Narrator"]): string[] {
  const problems: string[] = [];
  const known = new Set([...bible.characters.map((c) => c.name.toLowerCase()), ...allowedExtra.map((n) => n.toLowerCase())]);
  const strangers = [...new Set(scenes.flatMap((s) => s.characters).filter((n) => !known.has(n.trim().toLowerCase())))];
  if (strangers.length) problems.push(`Scenes use characters that are not in the story: ${strangers.join(", ")}. Use only: ${bible.characters.map((c) => c.name).join(", ")}.`);
  const covered = new Set(scenes.flatMap((s) => s.events ?? []));
  const missing = bible.events.filter((e) => !covered.has(e.order));
  if (missing.length && covered.size) problems.push(`These story events are not shown in any scene: ${missing.map((e) => `#${e.order} ${e.summary}`).join("; ")}. Every event must appear, in order.`);
  const order = scenes.flatMap((s) => s.events ?? []).filter((n) => n > 0);
  for (let i = 1; i < order.length; i++) {
    if (order[i]! < order[i - 1]!) { problems.push("Scenes show the story events out of chronological order. Keep the story's order."); break; }
  }
  return problems;
}

/** Short text form of the bible for downstream prompts. */
export function bibleText(b: StoryBible, opts: { withEvents?: boolean } = {}): string {
  return [
    `TITLE: ${b.title}. ${b.logline}`,
    b.sourceNotes ? `SOURCE (${b.sourceType}): ${b.sourceNotes}` : "",
    `CHARACTERS:\n${b.characters.map((c) => `- ${c.name} (${c.role}, ${c.species}): ${c.personality}. Looks: ${c.appearance}.${c.relationships.length ? ` Relations: ${c.relationships.map((r) => `${r.relation} of ${r.to}`).join(", ")}.` : ""}`).join("\n")}`,
    `LOCATIONS:\n${b.locations.map((l) => `- ${l.name} (${l.timeOfDay}): ${l.description}. ${l.visualDetails.join(", ")}`).join("\n")}`,
    b.objects.length ? `OBJECTS: ${b.objects.map((o) => `${o.name} (${o.description})`).join("; ")}` : "",
    opts.withEvents === false ? "" : `EVENTS IN ORDER:\n${b.events.map((e) => `${e.order}. [${e.location}; ${e.characters.join(", ")}; ${e.emotion}] ${e.summary}`).join("\n")}`,
    `MORAL: ${b.moral}`,
  ].filter(Boolean).join("\n");
}
