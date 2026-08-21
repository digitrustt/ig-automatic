/**
 * Words kept out of text we burn into a frame, on accounts that ask for it.
 *
 * Swearing in the source audio is always left alone — it is the speaker's
 * voice, not ours. The hook is our sentence, so whether it can swear is a
 * question about the account rather than about the clip: prank calls and
 * stream highlights are built out of it, and a hook that cleans it up sells
 * the wrong video. A news account is the opposite case.
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
 * Niches whose hooks stay clean, comma-separated. Everywhere else the hook may
 * swear as freely as the clip does.
 */
function cleanNiches(): string[] {
  return (process.env.CLEAN_HOOK_NICHES ?? 'newsy')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

export function checkOnScreenText(text: string, niche?: string): GuardResult {
  const trimmedText = text.trim();
  if (trimmedText.length < 8) return { ok: false, reason: 'hook_too_short' };

  // The length check above applies everywhere: a three-word hook is a failure
  // of the generator, not a stylistic choice.
  if (niche !== undefined && !cleanNiches().includes(niche)) return { ok: true };

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

  return { ok: true };
}
