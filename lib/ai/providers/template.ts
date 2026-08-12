import type { Copy, CopyProvider, PromptParts } from './types';

/**
 * No model at all: assembles copy from the source caption and a rotating set of
 * hook frames. Weaker than a real generator, but it costs nothing, never fails,
 * and keeps the pipeline moving when Ollama is down.
 */
export const templateProvider: CopyProvider = {
  name: 'template',

  async generate(parts: PromptParts): Promise<Copy> {
    const subject = firstSentence(parts.post.caption) ?? parts.post.niche;

    const frames = [
      `Nikt o tym nie mówi: ${subject}`,
      `To zmienia wszystko w ${parts.post.niche}`,
      `Obejrzyj do końca: ${subject}`,
      `Robisz to źle. ${subject}`,
    ];
    // Deterministic per clip, so a re-render produces the same edit.
    const frame = frames[hash(subject) % frames.length];

    return {
      hook: frame,
      caption: `${subject}\n\nZgadzasz się? Napisz w komentarzu.`,
      hashtags: hashtagsFor(parts.post.niche, parts.post.caption),
    };
  },
};

function firstSentence(caption: string | null): string | null {
  if (!caption) return null;
  const cleaned = caption
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/@[\p{L}\p{N}_.]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const sentence = cleaned.split(/(?<=[.!?])\s/)[0];
  return sentence.slice(0, 80);
}

/** Reuses the tags already on the source, topped up with the niche itself. */
function hashtagsFor(niche: string, caption: string | null): string[] {
  const found = (caption?.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) =>
    t.slice(1).toLowerCase(),
  );

  const nicheTag = niche.replace(/\s+/g, '').toLowerCase();
  return Array.from(new Set([nicheTag, ...found])).slice(0, 12);
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
