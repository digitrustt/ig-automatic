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
const BAND_H = 320;
const VIDEO_H = OUT_H - BAND_H;
const BAND_COLOR = '0x111111';

/**
 * Two reasons to cut long clips: short Reels hold retention better, and
 * Supabase's free tier rejects any file over 50MB. 60s at the bitrate cap
 * below lands around 37MB, which leaves comfortable headroom.
 */
const MAX_DURATION_SECONDS = 60;
const MAX_VIDEO_BITRATE = '5M';
const RATE_BUFFER = '10M';

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
      `y=(${BAND_H}-text_h)/2`,
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

  const args = ['-y', '-i', sourcePath];

  // Reels with no audio track get throttled, so lay down silence.
  if (!info.hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  args.push(
    '-map', '0:v:0',
    '-map', info.hasAudio ? '0:a:0' : '1:a:0',
    '-vf', filters,
    '-t', String(opts.maxDurationSeconds ?? MAX_DURATION_SECONDS),
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
