/**
 * Idempotent cast seed (no owner account needed):
 *   - Hindi voice profiles (Kokoro hf_/hm_ voices) and a Hindi voice for Rabbit & Squirrel
 *   - separate casts for Mahabharat, Ramayan and Chhatrapati Shivaji Maharaj stories, drawn as kid-friendly
 *     3D cartoon characters (Character.categories keeps them out of the general kids' stories and vice versa)
 * Existing characters and voices are never overwritten; only missing ones are created.
 *   npm run db:seed:cast
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type StoryCategory } from "../src/generated/prisma/client.ts";

type Voice = { name: string; voiceId: string; language: "en" | "hi"; speed: number; style: string };

const VOICES: Voice[] = [
  { name: "Hindi boy (HI)", voiceId: "hm_psi", language: "hi", speed: 1.08, style: "bright, playful young boy" },
  { name: "Hindi man (HI)", voiceId: "hm_psi", language: "hi", speed: 0.96, style: "calm, kind young man" },
  { name: "Hindi strong man (HI)", voiceId: "hm_omega", language: "hi", speed: 0.92, style: "strong, proud, warm" },
  { name: "Hindi elder man (HI)", voiceId: "hm_omega", language: "hi", speed: 0.86, style: "slow, wise elder" },
  { name: "Hindi woman (HI)", voiceId: "hf_beta", language: "hi", speed: 0.96, style: "gentle, loving woman" },
  { name: "Hindi elder woman (HI)", voiceId: "hf_alpha", language: "hi", speed: 0.88, style: "soft, affectionate grandmother" },
  { name: "Rabbit (HI)", voiceId: "hm_psi", language: "hi", speed: 1.0, style: "friendly, kind, reassuring" },
  { name: "Squirrel (HI)", voiceId: "hm_omega", language: "hi", speed: 1.12, style: "curious, playful, quick" },
  { name: "Boy (EN)", voiceId: "am_puck", language: "en", speed: 1.06, style: "bright young boy" },
  { name: "Man (EN)", voiceId: "am_michael", language: "en", speed: 0.96, style: "calm young man" },
  { name: "Strong man (EN)", voiceId: "am_fenrir", language: "en", speed: 0.92, style: "deep, strong" },
  { name: "Elder man (EN)", voiceId: "bm_fable", language: "en", speed: 0.9, style: "wise storyteller elder" },
  { name: "Woman (EN)", voiceId: "af_bella", language: "en", speed: 0.96, style: "gentle woman" },
  { name: "Elder woman (EN)", voiceId: "af_nicole", language: "en", speed: 0.9, style: "soft grandmother" },
];

type CastMember = {
  name: string;
  categories: StoryCategory[];
  description: string;
  appearance: string;
  clothingColors: string;
  personality: string;
  basePrompt: string;
  negativePrompt?: string;
  seed: number;
  isStoryteller?: boolean;
  expressionPresets: Record<string, string>;
  voice: string; // English voice profile name
  hindiVoice: string; // Hindi voice profile name
};

/** Kid-friendly 3D cartoon look shared by every human character, so the casts match the Rabbit & Squirrel world. */
const TOON = "cute 3D cartoon character, Pixar style kids animation, big expressive eyes, rounded friendly proportions";
const HUMAN_NEG = "realistic, photo, scary, angry face, blood, weapon pointed at viewer, extra fingers, deformed hands, extra limbs";
const DEVOTIONAL_NEG = `${HUMAN_NEG}, disrespectful, comic exaggeration, revealing clothes`;

const CAST: CastMember[] = [
  /* ---------- Mahabharat ---------- */
  {
    name: "Krishna", categories: ["mahabharat"], isStoryteller: true, seed: 210011,
    description: "Shri Krishna as a cheerful, wise young cowherd prince; friend and guide of the Pandavas.",
    appearance: "soft blue skin, big kind dark eyes, gentle smile, black curly hair, golden crown with a single peacock feather, holds a bamboo flute",
    clothingColors: "bright yellow silk dhoti (pitambar), gold jewellery, garland of small flowers",
    personality: "playful, loving, wise, calm in every trouble",
    basePrompt: `${TOON}, young Lord Krishna, soft blue skin, gentle smile, black curly hair, golden crown with one peacock feather, bright yellow silk dhoti, gold armlets and necklace, flower garland, holding a bamboo flute`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { smiling: "warm gentle smile", playful: "mischievous grin, playing the flute", calm: "serene, eyes soft", blessing: "right palm raised in blessing" },
    voice: "Boy (EN)", hindiVoice: "Hindi man (HI)",
  },
  {
    name: "Arjuna", categories: ["mahabharat"], seed: 210023,
    description: "Arjuna, the young Pandava prince and the greatest archer, focused and humble.",
    appearance: "fair skin, determined dark eyes, neat black hair tied up, small golden crown, carries a big wooden bow (Gandiva) and a quiver of arrows",
    clothingColors: "white and gold dhoti, red sash, gold armbands",
    personality: "focused, hard-working, respectful to his teacher, brave",
    basePrompt: `${TOON}, young prince Arjuna, fair skin, determined dark eyes, black hair tied in a top knot, small golden crown, white and gold dhoti with red sash, gold armbands, big wooden bow and quiver of arrows`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { focused: "narrowed focused eyes, aiming the bow", proud: "chin up, small smile", worried: "brows raised, unsure", happy: "big smile" },
    voice: "Man (EN)", hindiVoice: "Hindi man (HI)",
  },
  {
    name: "Bhima", categories: ["mahabharat"], seed: 210037,
    description: "Bhima, the strongest Pandava brother, big-hearted and always hungry.",
    appearance: "big broad strong body, round cheerful face, thick moustache, curly hair, carries a big golden mace (gada)",
    clothingColors: "orange dhoti, brown belt, gold armbands",
    personality: "strong, funny, protective, loves food",
    basePrompt: `${TOON}, Bhima the strong Pandava, big broad muscular body, round cheerful face, thick black moustache, curly hair, orange dhoti, gold armbands, holding a big golden mace on his shoulder`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { laughing: "booming laugh, head back", strong: "flexing, confident grin", hungry: "rubbing belly, eyes on food", angry: "frowning, but not scary" },
    voice: "Strong man (EN)", hindiVoice: "Hindi strong man (HI)",
  },
  {
    name: "Sudama", categories: ["mahabharat"], seed: 210041,
    description: "Sudama, Krishna's poor but loving childhood friend.",
    appearance: "thin, simple, kind face, small tuft of hair (shikha), carries a small cloth bundle of rice (poha)",
    clothingColors: "faded white dhoti and white shawl, no jewellery",
    personality: "humble, shy, honest, deeply loving",
    basePrompt: `${TOON}, Sudama a poor humble brahmin, thin, kind shy face, small tuft of hair, faded white dhoti and simple white shawl, barefoot, holding a small cloth bundle`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { shy: "looking down, small smile", teary: "happy tears", amazed: "mouth open, eyes wide" },
    voice: "Man (EN)", hindiVoice: "Hindi man (HI)",
  },
  {
    name: "Guru Drona", categories: ["mahabharat"], seed: 210053,
    description: "Guru Dronacharya, the strict but caring teacher of the princes.",
    appearance: "older man, long white beard, wise eyes, hair tied up, holds a bow",
    clothingColors: "saffron dhoti and saffron shawl, rudraksha beads",
    personality: "strict, fair, proud of good students",
    basePrompt: `${TOON}, Guru Dronacharya, elderly teacher with long white beard, wise kind eyes, hair tied up, saffron dhoti and shawl, rudraksha beads, holding a bow`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { teaching: "pointing upward, explaining", proud: "smiling, nodding", serious: "stern but kind" },
    voice: "Elder man (EN)", hindiVoice: "Hindi elder man (HI)",
  },
  {
    name: "Duryodhana", categories: ["mahabharat"], seed: 210067,
    description: "Duryodhana, the jealous Kaurava prince (shown sulky, never scary).",
    appearance: "proud face, thin moustache, sulky expression, tall golden crown",
    clothingColors: "maroon and gold dhoti, purple shawl, heavy gold jewellery",
    personality: "jealous, proud, stubborn",
    basePrompt: `${TOON}, prince Duryodhana, proud sulky face, thin moustache, tall golden crown, maroon and gold dhoti, purple shawl, heavy gold jewellery, arms crossed`,
    negativePrompt: `${HUMAN_NEG}, horror, monster`,
    expressionPresets: { jealous: "side-eye, frown", angry: "grumpy pout", shocked: "jaw dropped" },
    voice: "Strong man (EN)", hindiVoice: "Hindi strong man (HI)",
  },

  /* ---------- Ramayan ---------- */
  {
    name: "Shri Ram", categories: ["ramayan"], isStoryteller: true, seed: 220013,
    description: "Prabhu Shri Ram, the kind and truthful prince of Ayodhya.",
    appearance: "soft blue-grey skin, calm kind eyes, gentle smile, black hair, golden crown, carries a big bow (kodand) and quiver",
    clothingColors: "yellow silk dhoti, gold jewellery, flower garland",
    personality: "kind, calm, truthful, respectful to elders, protector of all",
    basePrompt: `${TOON}, Lord Shri Ram, soft blue-grey skin, calm kind eyes, gentle smile, black hair, golden crown, yellow silk dhoti, gold jewellery, flower garland, big bow on his shoulder`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { calm: "serene gentle smile", blessing: "right palm raised in blessing", determined: "focused eyes, drawing the bow", loving: "warm smile, soft eyes" },
    voice: "Man (EN)", hindiVoice: "Hindi man (HI)",
  },
  {
    name: "Sita Mata", categories: ["ramayan"], seed: 220027,
    description: "Mata Sita, gentle, brave and wise, Shri Ram's wife.",
    appearance: "fair skin, kind large eyes, long black braided hair with flowers, small gold crown and bindi",
    clothingColors: "red and orange saree with gold border, gold jewellery",
    personality: "gentle, brave, patient, loving",
    basePrompt: `${TOON}, Mata Sita, kind large eyes, gentle smile, long black braid with flowers, small gold crown, red bindi, red and orange saree with gold border, gold jewellery`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { smiling: "soft smile", sad: "teary but strong", praying: "hands folded, eyes closed" },
    voice: "Woman (EN)", hindiVoice: "Hindi woman (HI)",
  },
  {
    name: "Lakshman", categories: ["ramayan"], seed: 220031,
    description: "Lakshman, Shri Ram's loyal younger brother.",
    appearance: "fair skin, alert eyes, black hair, small golden crown, carries a bow and quiver",
    clothingColors: "green and gold dhoti, gold armbands",
    personality: "loyal, quick, protective, a little hot-tempered",
    basePrompt: `${TOON}, young prince Lakshman, fair skin, alert eyes, black hair, small golden crown, green and gold dhoti, gold armbands, bow and quiver`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { alert: "watchful, hand on bow", loyal: "bowing slightly, respectful", surprised: "wide eyes" },
    voice: "Man (EN)", hindiVoice: "Hindi man (HI)",
  },
  {
    name: "Hanuman", categories: ["ramayan"], seed: 220043,
    description: "Hanuman ji, the mighty and devoted friend of Shri Ram.",
    appearance: "cute strong monkey god with orange-red face and body, long tail, big bright eyes, golden crown, carries a golden mace (gada)",
    clothingColors: "red-orange dhoti, gold crown and jewellery",
    personality: "devoted, strong, humble, joyful, can fly and grow huge",
    basePrompt: `${TOON}, Lord Hanuman, cute strong monkey god, orange-red face and fur, long curled tail, big bright happy eyes, golden crown, red-orange dhoti, gold jewellery, golden mace`,
    negativePrompt: `${DEVOTIONAL_NEG}, realistic monkey`,
    expressionPresets: { joyful: "big happy smile", devoted: "hands folded, eyes closed, 'Jai Shri Ram'", flying: "flying with one fist forward", strong: "lifting something huge, confident" },
    voice: "Strong man (EN)", hindiVoice: "Hindi strong man (HI)",
  },
  {
    name: "Ravana", categories: ["ramayan"], seed: 220057,
    description: "Ravana, the proud ten-headed king of Lanka (shown grumpy and proud, never frightening).",
    appearance: "ten heads in a row with tall golden crowns, thick moustache, proud expression",
    clothingColors: "dark maroon and gold royal robes, heavy gold jewellery",
    personality: "proud, arrogant, stubborn",
    basePrompt: `${TOON}, king Ravana with ten heads in a row, tall golden crowns, thick moustache, proud grumpy face, dark maroon and gold royal robes, heavy gold jewellery`,
    negativePrompt: `${HUMAN_NEG}, horror, monster, demon teeth`,
    expressionPresets: { proud: "chin up, smirk", angry: "grumpy frown", shocked: "all ten heads surprised" },
    voice: "Strong man (EN)", hindiVoice: "Hindi strong man (HI)",
  },
  {
    name: "Shabari", categories: ["ramayan"], seed: 220069,
    description: "Mata Shabari, the old devotee who waited all her life for Shri Ram.",
    appearance: "very old kind woman, wrinkled smiling face, white hair in a bun, carries a small basket of berries",
    clothingColors: "simple off-white saree",
    personality: "patient, loving, devoted",
    basePrompt: `${TOON}, old woman Shabari, wrinkled kind smiling face, white hair in a bun, simple off-white saree, holding a small woven basket of red berries`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { joyful: "happy tears, big smile", waiting: "looking far, hand above eyes" },
    voice: "Elder woman (EN)", hindiVoice: "Hindi elder woman (HI)",
  },

  /* ---------- Chhatrapati Shivaji Maharaj ---------- */
  {
    name: "Shivaji Maharaj", categories: ["shivaji_maharaj"], isStoryteller: true, seed: 230011,
    description: "Chhatrapati Shivaji Maharaj, the brave and just founder of Swarajya.",
    appearance: "confident kind eyes, neat black beard and moustache, saffron Maratha pagadi turban with a pearl string and plume, sword (Bhavani talwar) at his waist",
    clothingColors: "white angarkha with saffron sash, saffron turban, pearl necklace",
    personality: "brave, clever, just, respectful to women and farmers, loves his people",
    basePrompt: `${TOON}, Chhatrapati Shivaji Maharaj, confident kind eyes, neat black beard and moustache, saffron Maratha pagadi turban with pearl string and small plume, white angarkha with saffron sash, pearl necklace, sheathed sword at his waist`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { proud: "standing tall, hand on sword hilt", kind: "warm smile", determined: "focused eyes, pointing forward", thinking: "hand on beard, planning" },
    voice: "Man (EN)", hindiVoice: "Hindi strong man (HI)",
  },
  {
    name: "Bal Shivaji", categories: ["shivaji_maharaj"], seed: 230023,
    description: "Young Shivaji as a boy, already brave and curious, learning from Jijabai.",
    appearance: "young boy, bright brave eyes, small saffron turban, small wooden sword",
    clothingColors: "white kurta with saffron sash, saffron turban",
    personality: "curious, brave, loves stories of heroes",
    basePrompt: `${TOON}, young boy Shivaji, bright brave eyes, small saffron turban, white kurta with saffron sash, holding a small wooden sword`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { curious: "head tilted, listening", brave: "chin up, fist on chest", happy: "big smile" },
    voice: "Boy (EN)", hindiVoice: "Hindi boy (HI)",
  },
  {
    name: "Rajmata Jijabai", categories: ["shivaji_maharaj"], seed: 230037,
    description: "Rajmata Jijabai, Shivaji Maharaj's mother and first teacher.",
    appearance: "graceful middle-aged woman, kind but strong eyes, hair in a bun, red bindi, nath nose ring",
    clothingColors: "green nauvari saree with gold border, gold jewellery",
    personality: "wise, strong, loving, tells stories of Ram and Krishna",
    basePrompt: `${TOON}, Rajmata Jijabai, graceful woman with kind strong eyes, hair in a bun, red bindi, Maharashtrian nath nose ring, green nauvari saree with gold border, gold jewellery`,
    negativePrompt: DEVOTIONAL_NEG,
    expressionPresets: { teaching: "telling a story, hand raised", proud: "proud smile", blessing: "hand on child's head" },
    voice: "Woman (EN)", hindiVoice: "Hindi woman (HI)",
  },
  {
    name: "Tanaji Malusare", categories: ["shivaji_maharaj"], seed: 230041,
    description: "Tanaji Malusare, Shivaji Maharaj's brave friend and commander.",
    appearance: "strong warrior, thick curled moustache, brave eyes, red Maratha turban, shield and sword on his back",
    clothingColors: "white angarkha with red sash, red turban",
    personality: "loyal, fearless, funny, keeps his promise",
    basePrompt: `${TOON}, Maratha warrior Tanaji Malusare, strong, thick curled moustache, brave eyes, red Maratha turban, white angarkha with red sash, round shield and sword on his back`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { brave: "fist raised, shouting 'Har Har Mahadev'", loyal: "hand on heart, bowing", laughing: "big hearty laugh" },
    voice: "Strong man (EN)", hindiVoice: "Hindi strong man (HI)",
  },
  {
    name: "Dadoji Konddev", categories: ["shivaji_maharaj"], seed: 230053,
    description: "Dadoji Konddev, the wise elder who taught young Shivaji.",
    appearance: "elderly man, white moustache, kind wise eyes, white turban",
    clothingColors: "white dhoti and angarkha, white turban",
    personality: "wise, patient, strict about learning",
    basePrompt: `${TOON}, elderly teacher Dadoji Konddev, white moustache, kind wise eyes, white turban, white dhoti and angarkha`,
    negativePrompt: HUMAN_NEG,
    expressionPresets: { teaching: "explaining with a raised finger", proud: "smiling, nodding" },
    voice: "Elder man (EN)", hindiVoice: "Hindi elder man (HI)",
  },
];

export async function seedCast(prisma: PrismaClient) {
  for (const v of VOICES) await prisma.voiceProfile.upsert({ where: { name: v.name }, create: { ...v, engine: "kokoro" }, update: {} });
  const byName = new Map((await prisma.voiceProfile.findMany()).map((v) => [v.name, v.id]));

  // Hindi voice for the general kids' cast (only if none chosen yet)
  for (const [name, voice] of [["Rabbit", "Rabbit (HI)"], ["Squirrel", "Squirrel (HI)"]] as const) {
    await prisma.character.updateMany({ where: { name, hindiVoiceProfileId: null }, data: { hindiVoiceProfileId: byName.get(voice)! } });
  }

  let created = 0;
  for (const { voice, hindiVoice, negativePrompt, ...c } of CAST) {
    const exists = await prisma.character.findUnique({ where: { name: c.name } });
    if (exists) continue;
    await prisma.character.create({
      data: {
        ...c, furColors: "", negativePrompt: negativePrompt ?? "", isStoryteller: c.isStoryteller ?? false,
        voiceProfileId: byName.get(voice)!, hindiVoiceProfileId: byName.get(hindiVoice)!,
      },
    });
    created++;
  }
  return created;
}

// run directly: npm run db:seed:cast
if (process.argv[1]?.replace(/\\/g, "/").endsWith("prisma/seed-cast.ts")) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  seedCast(prisma)
    .then(async (n) => {
      await prisma.activityLog.create({ data: { entityType: "system", action: "seed", message: `Cast seeded: ${n} new character(s) for Mahabharat / Ramayan / Shivaji Maharaj; Hindi voices added` } });
      console.log(`Cast seed complete: ${n} new character(s).`);
    })
    .catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
