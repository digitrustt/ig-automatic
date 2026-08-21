/**
 * Recognises a clip we have already published, by what is said in it.
 *
 * The obvious tool is the perceptual hash the repost path uses, and it is the
 * wrong one here. Compilations of phone calls and stream highlights often run
 * over a static image or a waveform, so every clip cut from one of them shares
 * a frame — the hash would call the whole video a single duplicate. Two cuts of
 * the same call, meanwhile, look nothing alike if the uploaders used different
 * backdrops.
 *
 * What actually repeats is the words. The same call turning up in two people's
 * best-of playlists is transcribed twice, never identically — a mishearing
 * here, different punctuation there — so this compares overlapping runs of
 * words rather than the strings themselves.
 */

/**
 * Words per shingle.
 *
 * Every word that comes out differently destroys this many shingles, so the
 * run has to be short enough to survive a mishearing or two across a
 * forty-second clip. Below four, ordinary Polish phrases start colliding on
 * their own.
 */
const SHINGLE_WORDS = 4;

/**
 * Overlap at which two clips are the same material.
 *
 * Transcription noise costs a handful of shingles, and a compilation may cut
 * the call at a slightly different point, so the bar sits well below identity.
 * Two unrelated clips of the same speaker share far less than this.
 */
export const DUPLICATE_SIMILARITY = 0.55;

export function shingles(text: string, size = SHINGLE_WORDS): Set<string> {
  const words = normalise(text)
    .split(/\s+/)
    .filter(Boolean);

  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(' '));
  }
  return out;
}

/**
 * Strips accents before comparing.
 *
 * Two passes of the same Polish audio disagree on diacritics far more often
 * than on the words themselves — "dzwonie" for "dzwonię", "samochod" for
 * "samochód". Left in, those spellings read as different words and cost four
 * shingles each, which was enough to let a re-transcription of the same call
 * through as new material.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

/** Jaccard overlap, so a long clip containing a short one still scores high. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) shared++;

  // Containment rather than plain Jaccard: a forty-second cut sitting inside a
  // sixty-second one is the same material, and Jaccard would score it 0.66
  // against a threshold it might not clear.
  return shared / small.size;
}

export function findDuplicate(
  text: string,
  existing: Array<{ id: string; transcript: string | null }>,
): string | null {
  const mine = shingles(text);
  if (mine.size === 0) return null;

  for (const row of existing) {
    if (!row.transcript) continue;
    if (similarity(mine, shingles(row.transcript)) >= DUPLICATE_SIMILARITY) {
      return row.id;
    }
  }
  return null;
}
