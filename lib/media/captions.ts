import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Word } from '@/lib/ai/transcribe';

/**
 * Words per caption line.
 *
 * Short bursts beat full sentences here: the viewer reads a phrase at a glance
 * and looks back at the picture, and the constant change gives the frame
 * motion even when the shot is static.
 */
const WORDS_PER_LINE = 3;

/** Captions sit above the bottom edge, clear of the platform's own UI. */
const MARGIN_V = 260;

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  /** Seconds to subtract from every timestamp, i.e. the clip's in-point. */
  offsetSeconds?: number;
}

/**
 * Builds a subtitle track from word timestamps.
 *
 * ASS rather than SRT because it carries styling — size, outline, position —
 * inside the file, so the look does not depend on ffmpeg flags and survives
 * any change to the filter chain.
 */
export async function writeCaptionFile(
  words: Word[],
  dir: string,
  style: CaptionStyle = {},
): Promise<string> {
  const fontName = style.fontName || process.env.CAPTION_FONT || 'DejaVu Sans';
  const fontSize = style.fontSize ?? 58;
  const offset = style.offsetSeconds ?? 0;

  const lines: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    const group = words.slice(i, i + WORDS_PER_LINE);
    const start = group[0].start - offset;
    const end = group[group.length - 1].end - offset;
    if (end <= 0) continue;

    const text = group
      .map((w) => w.word.trim())
      .join(' ')
      .replace(/\{/g, '(')
      .replace(/\}/g, ')')
      .replace(/\n/g, ' ');

    lines.push(
      `Dialogue: 0,${ts(Math.max(0, start))},${ts(end)},Default,,0,0,0,,${text.toUpperCase()}`,
    );
  }

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,${MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;

  const file = path.join(dir, 'captions.ass');
  await writeFile(file, content, 'utf8');
  return file;
}

/** ASS wants H:MM:SS.cc — hours unpadded, centiseconds. */
function ts(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(
    Math.min(cs, 99),
  ).padStart(2, '0')}`;
}

/** Words falling inside a clip, for captioning just that span. */
export function wordsBetween(words: Word[], start: number, end: number): Word[] {
  return words.filter((w) => w.end > start && w.start < end);
}
