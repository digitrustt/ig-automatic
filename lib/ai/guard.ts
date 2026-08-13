/**
 * Words that must never appear in text we burn into a frame.
 *
 * Deliberately narrow. Swearing in the source audio is normal for this kind of
 * content and is left alone — it is the speaker's voice, not ours. A hook is
 * different: it is the first thing anyone sees, it carries the account's name
 * directly beneath it, and it is our sentence rather than theirs.
 *
 * Stems, because Polish inflects: "kurw" catches every form of it.
 */
const BLOCKED_STEMS = [
  // Polish
  'kurw', 'chuj', 'pizd', 'jeban', 'jebac', 'jebać', 'pierdol', 'spierdal',
  'wypierdal', 'zajeb', 'fiut', 'huj', 'skurwy', 'debil', 'idiot', 'kutas',
  'dziwk', 'szmat', 'cip',
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'whore', 'retard',
];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Whisper mishears, and a mistranscribed obscenity reads as deliberate once it
 * is on screen. Cheaper to drop the clip than to publish it: a long video
 * yields several, and losing one costs nothing.
 */
export function checkOnScreenText(text: string): GuardResult {
  const normalised = text
    .toLowerCase()
    // Catches spacing and leetspeak ("k u r w a", "sh1t"). Does not catch a
    // letter replaced by a symbol ("k*rwa"), and is not meant to: the threat
    // here is a mistranscription the model repeated in good faith, not an
    // author trying to slip something past a filter.
    .replace(/[\s._-]+/g, '')
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a');

  const hit = BLOCKED_STEMS.find((stem) => normalised.includes(stem));
  if (hit) return { ok: false, reason: `blocked_term:${hit}` };

  const trimmed = text.trim();
  if (trimmed.length < 8) return { ok: false, reason: 'hook_too_short' };

  return { ok: true };
}
