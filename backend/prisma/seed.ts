/**
 * Idempotent seed: owner account, the Rabbit & Squirrel universe, default voice profiles,
 * and a DISABLED daily schedule (automation is switched on deliberately from Settings).
 *   OWNER_EMAIL=me@example.com OWNER_PASSWORD='long passphrase' npm run db:seed
 */
import argon2 from "argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

async function main() {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) throw new Error("Set OWNER_EMAIL and OWNER_PASSWORD to create the owner account (no default credentials exist).");
  if (password.length < 12) throw new Error("OWNER_PASSWORD must be at least 12 characters.");

  await prisma.user.upsert({
    where: { email },
    create: { email, displayName: "Owner", role: "owner", passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    update: {},
  });

  // Kokoro v1.0 voice ids. Editable later in Character Studio.
  const voices = [
    { name: "Narrator (EN)", engine: "kokoro" as const, voiceId: "af_heart", language: "en" as const, speed: 0.95, style: "warm, gentle storyteller", isNarrator: true },
    { name: "Narrator (HI)", engine: "kokoro" as const, voiceId: "hf_alpha", language: "hi" as const, speed: 0.95, style: "warm Hindi storyteller", isNarrator: true },
    { name: "Rabbit voice", engine: "kokoro" as const, voiceId: "am_michael", language: "en" as const, speed: 1.0, style: "friendly, kind, reassuring", isNarrator: false },
    { name: "Squirrel voice", engine: "kokoro" as const, voiceId: "am_puck", language: "en" as const, speed: 1.08, style: "curious, playful, quick", isNarrator: false },
  ];
  for (const v of voices) await prisma.voiceProfile.upsert({ where: { name: v.name }, create: v, update: {} });
  const rabbitVoice = await prisma.voiceProfile.findUniqueOrThrow({ where: { name: "Rabbit voice" } });
  const squirrelVoice = await prisma.voiceProfile.findUniqueOrThrow({ where: { name: "Squirrel voice" } });

  const characters = [
    {
      name: "Rabbit",
      description: "A cute, kind-hearted young rabbit and the main storyteller of the channel.",
      appearance: "small round body, very large expressive amber-brown eyes with bright catchlights, long upright ears with soft pink inner ears, tiny pink nose, fluffy round white tail",
      furColors: "soft cream-white fur with light honey-beige patches on the ears and paws",
      clothingColors: "teal knitted scarf with a small yellow star pin",
      personality: "friendly, warm, patient, wise beyond her years; always helps others",
      basePrompt: "cute stylized 3D animated rabbit, cream-white fur with honey-beige ear tips and paws, large amber-brown expressive eyes, long upright ears with pink insides, wearing a teal knitted scarf with a small yellow star pin, soft rounded proportions",
      negativePrompt: "realistic, scary, sharp teeth, human body, extra limbs, deformed, different scarf color",
      seed: 104729,
      isStoryteller: true,
      expressionPresets: { happy: "big warm smile, eyes curved", sad: "ears drooping, teary eyes", surprised: "wide eyes, ears straight up", thinking: "paw on chin, eyes looking up" },
      voiceProfileId: rabbitVoice.id,
    },
    {
      name: "Squirrel",
      description: "A cute, curious little squirrel; the Rabbit's best friend and supporting storyteller.",
      appearance: "small slender body, huge bushy curled tail, big glossy dark-brown eyes, tiny tufted ears, small buck teeth visible when smiling",
      furColors: "warm russet-orange fur with a cream belly and cream tail tip",
      clothingColors: "small green leaf-patterned satchel worn across the body",
      personality: "curious, playful, energetic, a little mischievous, loyal friend",
      basePrompt: "cute stylized 3D animated squirrel, warm russet-orange fur with cream belly and cream tail tip, huge bushy curled tail, big glossy dark-brown eyes, tiny tufted ears, small green leaf-patterned satchel across the body, soft rounded proportions",
      negativePrompt: "realistic, scary, rat-like, human body, extra limbs, deformed, different satchel color",
      seed: 130363,
      isStoryteller: false,
      expressionPresets: { excited: "bouncing, tail fluffed, wide grin", curious: "head tilted, one ear raised", worried: "tail wrapped around body, small frown", laughing: "eyes closed, paws on belly" },
      voiceProfileId: squirrelVoice.id,
    },
  ];
  for (const c of characters) await prisma.character.upsert({ where: { name: c.name }, create: c, update: {} });

  const schedules = await prisma.dailySchedule.count();
  if (!schedules) {
    await prisma.dailySchedule.create({
      data: {
        enabled: false,
        targetCount: 5,
        startTime: "01:00",
        timezone: process.env.TZ_NAME || Intl.DateTimeFormat().resolvedOptions().timeZone,
        categories: ["rabbit_squirrel_adventure", "kids_moral", "friendship_kindness", "funny_animals", "inspirational"],
        language: "en",
        maxConcurrency: 1,
      },
    });
  }

  await prisma.activityLog.create({ data: { entityType: "system", action: "seed", message: "Database seeded (owner, characters, voices, schedule)" } });
  console.log(`Seed complete. Owner: ${email}`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
