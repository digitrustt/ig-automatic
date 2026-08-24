import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, probe, type MediaInfo } from './ffmpeg';

export interface RemixOptions {
  /** Big text burned over the opening seconds — the scroll-stopper. */
  hookText: string;
  /** Persistent handle mark, e.g. "@yourpage". */
  brandHandle: string;
  maxDurationSeconds?: number;
  fontPath?: string;
  /** ASS subtitle file to burn in — see lib/media/captions.ts. */
  captionFile?: string;
  /** Sponsor mark burned into the frame — see sponsorLogo(). */
  logoPath?: string;
}

const OUT_W = 1080;
const OUT_H = 1920;

/**
 * Our hook lives in a band above the video rather than on top of it.
 *
 * Relatable and meme clips — the bulk of what gets reposted — usually carry
 * their own burned-in caption across the upper third of the frame. Overlaying
 * our hook there produced two texts stacked on each other and neither was
 * readable. A band cannot collide with anything, whatever the source looks
 * like, and it doubles as consistent branding across the feed.
 */
const BAND_H = 440;
const VIDEO_H = OUT_H - BAND_H;
const BAND_COLOR = '0x111111';

/**
 * Two reasons to cut long clips: short Reels hold retention better, and
 * Supabase's free tier rejects any file over 50MB. 60s at the bitrate cap
 * below lands around 37MB, which leaves comfortable headroom.
 */
const MAX_DURATION_SECONDS = 90;

/**
 * Sponsor logo geometry.
 *
 * Campaigns require the mark at the top of the reel and visible for its whole
 * length, which is exactly what the band already is — so the logo goes inside
 * it, above the hook, and the band grew to make room.
 *
 * The supplied asset is a 1280x720 sheet with the logo floating in white
 * space. CROP is that artwork's measured bounding box; without it the padding
 * would dominate and the mark itself would render too small to read. The white
 * is keyed out so the logo sits on the band instead of inside a white slab.
 */
const LOGO_CROP = '980:412:150:221';
const LOGO_H = 168;
const LOGO_TOP = 18;
/** Breathing room between the sponsor mark and our hook. */
const LOGO_GAP = 20;

/**
 * Length of the fade at each end of a clip.
 *
 * A cut lifted out of the middle of a video starts and ends abruptly however
 * carefully the boundary was chosen, and the hard cut is what reads as ripped
 * rather than edited. Short enough not to eat the first word, long enough to
 * register.
 */
const FADE_IN = 0.2;
const FADE_OUT = 0.3;
// Ninety seconds at 5M would land near 56MB, past the storage ceiling below.
// 4M keeps a minute and a half comfortably inside it, and this material —
// talking heads from a 720p source — does not miss the difference.
const MAX_VIDEO_BITRATE = '4M';
const RATE_BUFFER = '8M';

/** Hard ceiling from the storage tier; we fail before uploading, not during. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

function fontPath(explicit?: string): string {
  const candidate = explicit || process.env.FONT_PATH;
  if (candidate) return candidate;

  // Sensible defaults per platform; override with FONT_PATH when neither fits.
  return process.platform === 'darwin'
    ? '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
}

/**
 * Text reaches drawtext through a file, never inline.
 *
 * Inline `text=` sits inside the filtergraph string, so every colon, quote,
 * percent and backslash needs escaping — and newlines cannot survive it at all
 * (the escape's own backslash gets eaten by the graph parser, which silently
 * renders a literal "n" instead of breaking the line). `textfile=` hands the
 * bytes over untouched, so LLM-generated copy in any language just works.
 *
 * Only the path itself needs escaping, and we control that.
 */
function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Greedy wrap so a long hook does not run off the edge of a 9:16 frame. */
export function wrapText(text: string, maxCharsPerLine = 22): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxCharsPerLine) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines.join('\n');
}

export interface RemixResult {
  outputPath: string;
  info: MediaInfo;
}

/**
 * Produces our own edit of a source clip: the video reframed to fill the lower
 * portion of a 9:16 canvas, under a branded band carrying our hook and handle.
 * This layer is what makes the upload our post rather than a straight copy —
 * both platforms demote verbatim reuploads, and a bare re-encode would not
 * clear that bar.
 */
export async function remix(
  sourcePath: string,
  dir: string,
  opts: RemixOptions,
): Promise<RemixResult> {
  const info = await probe(sourcePath);
  const output = path.join(dir, 'remix.mp4');
  const font = fontPath(opts.fontPath);

  // The fade-out has to be placed against the clip's real length, which is
  // whichever runs out first: the footage or the duration cap.
  const duration = Math.min(
    info.durationSeconds,
    opts.maxDurationSeconds ?? MAX_DURATION_SECONDS,
  );
  const fades = duration > (FADE_IN + FADE_OUT) * 2;

  const hookFile = path.join(dir, 'hook.txt');
  const brandFile = path.join(dir, 'brand.txt');
  await writeFile(hookFile, wrapText(opts.hookText, 26), 'utf8');
  await writeFile(brandFile, opts.brandHandle, 'utf8');

  const filters = [
    // Fill the video area, cropping overflow rather than letterboxing.
    `scale=${OUT_W}:${VIDEO_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${VIDEO_H}`,
    'fps=30',
    // Push the frame down, leaving an empty band across the top.
    `pad=${OUT_W}:${OUT_H}:0:${BAND_H}:color=${BAND_COLOR}`,
    // Hook, centred in the band. On screen throughout — it reads as the
    // post's caption rather than a card that flashes past.
    [
      `drawtext=fontfile='${escapeFilterPath(font)}'`,
      `textfile='${escapeFilterPath(hookFile)}'`,
      'fontcolor=white',
      'fontsize=54',
      'line_spacing=10',
      'x=(w-text_w)/2',
      // Centred in what the logo leaves, not in the whole band.
      `y=${LOGO_TOP + LOGO_H + LOGO_GAP}+((${BAND_H}-46)-${LOGO_TOP + LOGO_H + LOGO_GAP}-text_h)/2`,
    ].join(':'),
    // Handle mark, bottom of the band so it never covers the video.
    [
      `drawtext=fontfile='${escapeFilterPath(font)}'`,
      `textfile='${escapeFilterPath(brandFile)}'`,
      'fontcolor=white@0.5',
      'fontsize=30',
      'x=(w-text_w)/2',
      `y=${BAND_H}-46`,
    ].join(':'),
    // Burned-in captions, last so they sit above everything. Spoken-word
    // clips lose most of their audience to muted autoplay without them.
    opts.captionFile ? `subtitles='${escapeFilterPath(opts.captionFile)}'` : null,
  ]
    .filter(Boolean)
    .join(',');

  // Applied after any overlay, so the whole composed frame fades rather than
  // the video sliding out from under marks that stay put. Skipped on a clip
  // too short to hold both fades, where they would meet in the middle.
  const fadeChain = fades
    ? `fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${(duration - FADE_OUT).toFixed(2)}:d=${FADE_OUT}`
    : null;

  const args = ['-y', '-i', sourcePath];
  let nextInput = 1;

  const logoInput = opts.logoPath ? nextInput++ : null;
  if (opts.logoPath) args.push('-i', opts.logoPath);

  // Reels with no audio track get throttled, so lay down silence.
  const silenceInput = info.hasAudio ? null : nextInput++;
  if (!info.hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  if (logoInput === null) {
    args.push('-map', '0:v:0');
  } else {
    // A second input means the whole chain has to move into filter_complex.
    // The logo goes on before the fades so it fades with everything else —
    // a mark that stays lit over black at the end looks like a rendering bug.
    args.push(
      '-filter_complex',
      [
        `[0:v]${filters}[base]`,
        `[${logoInput}:v]crop=${LOGO_CROP},scale=-1:${LOGO_H},` +
          'colorkey=0xFFFFFF:0.25:0.05[logo]',
        `[base][logo]overlay=(W-w)/2:${LOGO_TOP}` +
          (fadeChain ? `,${fadeChain}` : '') +
          '[v]',
      ].join(';'),
      '-map', '[v]',
    );
  }

  args.push(
    '-map', info.hasAudio ? '0:a:0' : `${silenceInput}:a:0`,
    '-t', String(opts.maxDurationSeconds ?? MAX_DURATION_SECONDS),
    ...(logoInput === null
      ? ['-vf', fadeChain ? `${filters},${fadeChain}` : filters]
      : []),
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'medium',
    '-crf', '21',
    // CRF alone lets a busy clip balloon past the storage limit, so cap the
    // peak rate too: quality floats below the cap, size stays bounded.
    '-maxrate', MAX_VIDEO_BITRATE,
    '-bufsize', RATE_BUFFER,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );

  if (fades) {
    args.push(
      '-af',
      `afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${(duration - FADE_OUT).toFixed(2)}:d=${FADE_OUT}`,
    );
  }

  args.push(
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
  );

  if (!info.hasAudio) args.push('-shortest');

  args.push(output);
  await ffmpeg(args);

  const { size } = await stat(output);
  if (size > MAX_OUTPUT_BYTES) {
    throw new Error(
      `Rendition is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_OUTPUT_BYTES / 1024 / 1024
      }MB storage limit`,
    );
  }

  return { outputPath: output, info: await probe(output) };
}
