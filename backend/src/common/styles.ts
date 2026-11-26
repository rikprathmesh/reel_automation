/**
 * Visual style presets. One style per reel (never mixed), applied to every scene image.
 *
 * The five art styles follow the rules of the "Kahani" animated-story guide (aivnora.web.app/kahani.html):
 * Shadow Puppet, Folk Poster, Chibi, Painterly and Pinman. They are adapted here for a diffusion model
 * (DreamShaper / SD 1.5), which follows style words well but cannot hit exact hex colours, so palettes are
 * described in words. "storybook" is the original ReelForge look.
 *
 * - prompt / negative: added to every scene prompt.
 * - refWeight: IP-Adapter strength for the character model sheets. The sheets are drawn in the storybook
 *   look, so a strong reference would pull other styles back to 3D; flat styles use a light touch or none.
 * - cast: "full" re-describes each character's appearance; "name" only names them (silhouettes and stick
 *   figures have no fur colours, clothes or faces to describe).
 * - writing: guidance for the story writer so scenes suit the style.
 */
export const STYLE_IDS = ["storybook", "shadow_puppet", "folk_poster", "chibi", "painterly", "pinman"] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export interface StylePreset {
  label: string;
  bestFor: string;
  prompt: string;
  negative: string;
  refWeight: number;
  /** appended last so scenes get a full setting instead of a plain backdrop (optional) */
  background?: string;
  cast: "full" | "name";
  writing: string;
}

const COMMON_NEGATIVE = "text, letters, watermark, logo, signature, blurry, deformed, extra limbs, bad anatomy, lowres, jpeg artifacts";

export const STYLES: Record<StyleId, StylePreset> = {
  storybook: {
    label: "3D Cartoon",
    bestFor: "Kids' stories, friendship, funny animals, kids' Mahabharat / Ramayan / Shivaji Maharaj",
    // LCM sampling runs at cfg 1.5, where the negative prompt barely acts: the cartoon look has to be carried by
    // weighted positive words, and anything photographic ("cinematic", "film still") is kept out.
    prompt: "(3d cartoon animation:1.35), (cute kids cartoon:1.2), Pixar Disney style animated movie, big expressive cartoon eyes, smooth simple rounded shapes, bright cheerful saturated colours, soft bright daylight, vertical composition",
    background: "(detailed colourful cartoon background:1.2), full scene",
    negative: `${COMMON_NEGATIVE}, extra fingers, photorealistic, realistic, photo, photograph, real animal, realistic fur texture, dslr, bokeh, depth of field, dark, gloomy, dramatic lighting, scary`,
    // 0.7 copied the model sheet's grey backdrop into every scene; 0.45 keeps identity and lets the setting show
    refWeight: 0.45,
    cast: "full",
    writing: "Bright, warm, expressive storybook scenes with clear character emotions.",
  },
  shadow_puppet: {
    label: "Shadow Puppet",
    bestFor: "Night, battles, confrontations, a vow (Tholu Bommalata)",
    prompt: "Indian Tholu Bommalata leather shadow puppet theatre, flat solid black silhouette figures in strict side profile, no facial features, clusters of small glowing pin-hole perforations in the leather, thin dark rods below the puppets, glowing amber cloth screen backlit by a single oil lamp, bright orange glow at the centre fading to near-black edges, faint horizontal cloth texture, palette only near-black, dark brown, burnt orange, amber and pale gold, flat 2D, vertical composition",
    negative: `${COMMON_NEGATIVE}, blue, green, purple, colourful clothing, 3D render, gradient shading on figures, detailed face, eyes, front-facing figure, photo, crowd`,
    refWeight: 0,
    cast: "name",
    writing: "Every character must be shown in clear side profile with a strong, readable pose (drawn bow, bowed back, raised arm). Lamp-lit or night scenes. Avoid crowds and close-up facial emotion; emotion comes from posture. One clear action per scene.",
  },
  folk_poster: {
    label: "Folk Poster",
    bestFor: "A court, a throne, a blessing, a wedding, an arrival (Madhubani)",
    prompt: "Madhubani Mithila folk painting, flat colours with thick black outlines on every shape, ochre handmade paper background, every empty space filled with hatching, dots, small triangles, fish and leaf patterns, figures in profile with one large almond-shaped eye and red lips, decorative double border with red and green triangles, palette of red, deep green, gold, indigo blue, brown and pink, no shading, flat 2D Indian folk art, vertical composition",
    negative: `${COMMON_NEGATIVE}, 3D render, gradient, soft shadow, realistic, photo, plain empty background, thin lines, anime`,
    refWeight: 0.2,
    cast: "full",
    writing: "Ceremonial, symmetrical moments suit this style: a court, a throne, a blessing, an arrival. Divine figures get a large golden halo behind the head. Avoid fast action and speed.",
  },
  chibi: {
    label: "Chibi",
    bestFor: "Childhood, play, family feed, younger viewers",
    prompt: "cute chibi kawaii 2D illustration, big round head and small round body, huge glossy eyes with white highlights, soft pink blush on both cheeks, thin soft brown outlines, pastel palette of sky blue, mint, soft green grass, cream, coral and pink, gentle single-tone shading, playful sparkles, bright cheerful mood, vertical composition",
    negative: `${COMMON_NEGATIVE}, black outlines, realistic proportions, dark colours, harsh shadows, rim light, 3D render, photo, scary`,
    refWeight: 0.45,
    cast: "full",
    writing: "Playful, bouncy, light-hearted scenes. A small companion creature (mouse, squirrel or bird) can mirror the main action. Avoid grief, war and serious vows.",
  },
  painterly: {
    label: "Painterly",
    bestFor: "Flight, sunrise, a journey, a moment of awe",
    prompt: "atmospheric digital matte painting, no outlines, soft painterly brushwork, three layers of mist and clouds receding into the distance, strong golden rim light on the edges of the figure, dawn sky from deep indigo and violet to orange and gold at the horizon, far objects hazy and low contrast, epic sense of scale, cinematic, vertical composition",
    negative: `${COMMON_NEGATIVE}, line art, outlines, ink lines, flat colours, cartoon, cel shading, hard shadows, 3D render`,
    refWeight: 0.3,
    cast: "full",
    writing: "Wide, sweeping scenes of travel, flight, rising and falling, with light changing from night to dawn. Avoid close dialogue and small detailed objects.",
  },
  pinman: {
    label: "Pinman",
    bestFor: "A moral, an idea, a before-and-after contrast",
    prompt: "minimalist stick figure drawing, black stick figures with circle heads and thick round-capped lines, no faces, no hands, no clothes, plain off-white paper background, one horizontal ground line, lots of empty space, small figures, exactly one small object in bright red as the only colour, short curved motion lines beside moving limbs, clean flat vector, vertical composition",
    negative: `${COMMON_NEGATIVE}, multiple colours, colourful, faces, eyes, detailed, shading, texture, realistic, 3D, background scenery, fur, clothing`,
    refWeight: 0,
    cast: "name",
    writing: "Each scene is one large, clear gesture (throw, fall, reach, turn away) by simple figures. Name exactly one key object per scene that will be the single red accent. Ideas, morals and contrasts work best; avoid devotional or ornamental scenes.",
  },
};

export function stylePreset(id: string | null | undefined): StylePreset {
  return STYLES[(id ?? "storybook") as StyleId] ?? STYLES.storybook;
}
