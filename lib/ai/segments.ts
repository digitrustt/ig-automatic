import { z } from 'zod';
import type { Transcript, Word } from './transcribe';

export const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  hook: z.string(),
  reason: z.string().optional(),
  /** True when the passage is the host selling something, not their content. */
  sponsor: z.boolean().optional(),
});

export type Segment = z.infer<typeof SegmentSchema>;

/** Reels below this are too thin to land; above it retention falls off. */
const MIN_SEGMENT_SECONDS = 18;
const MAX_SEGMENT_SECONDS = 60;

/** Seconds of transcript per prompt line — enough context, few enough tokens. */
const LINE_SECONDS = 8;

const SYSTEM = `You select clips from a long video transcript for a vertical
short-form feed.

A clip has to work for someone who has never seen the video and has given it
half a second. That rules out most of a transcript: setup, travel between
places, pleasantries, anything that only makes sense with what came before.

What earns a clip:
- A complete moment with its own beginning and payoff. A reaction, a verdict, a
  confrontation, a number that surprises, a story told in three sentences.
- It stands alone. If understanding it needs a fact from earlier in the video,
  it is not a clip.
- It is the video's own content. Never take a sponsor read or an advert — a
  discount code, a product pitch, "the partner of this episode". These look
  perfect from a transcript, because an advert is written to stand alone and
  end on a call to action. They are worthless as clips.
- It opens on something worth staying for. A clip that starts mid-sentence on a
  transition has already lost.

Prefer stronger clips over filling a quota — a weak clip costs the account
reach. But do return every moment that genuinely stands on its own; a long
video usually holds several.

For each clip write a hook: the line printed on screen, in the video's own
language, 25 to 55 characters.

A hook is not a label. "129 zł" and "A lot of cheese" name the subject and give
the viewer no reason to stay. A hook sets up a gap the clip closes: state the
situation and withhold the outcome. "Zapłacił 129 zł za kebaba" works because
the price is absurd and the verdict is still coming. Write the hook only after
you know what the clip's payoff is, then promise exactly that.

Mark every passage that is an advert with "sponsor": true — including ones you
would otherwise have skipped. Note the difference: a host praising a product
they were paid for is an advert; a host reporting on somebody else's ad deal is
not, and that is ordinary content.

Reply with JSON only: {"segments": [{"start": number, "end": number,
"hook": string, "reason": string, "sponsor": boolean}]} where start and end
are seconds.`;

const SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'Clip start in seconds.' },
          end: { type: 'number', description: 'Clip end in seconds.' },
          hook: { type: 'string', description: 'On-screen line, under 60 characters.' },
          reason: { type: 'string', description: 'Why this stands alone.' },
          sponsor: {
            type: 'boolean',
            description:
              'True if this passage is an advert read by the host — a product pitch, a discount code, a sponsor mention. False for the video\'s own content, including when it merely discusses advertising.',
          },
        },
        required: ['start', 'end', 'hook', 'reason', 'sponsor'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
} as const;

/** Collapses words into timestamped lines the model can point at. */
export function timedTranscript(words: Word[]): string {
  const lines: string[] = [];
  let bucketStart = words[0]?.start ?? 0;
  let bucket: string[] = [];

  for (const w of words) {
    if (w.start - bucketStart >= LINE_SECONDS && bucket.length > 0) {
      lines.push(`[${bucketStart.toFixed(0)}] ${bucket.join(' ')}`);
      bucket = [];
      bucketStart = w.start;
    }
    bucket.push(w.word);
  }
  if (bucket.length > 0) lines.push(`[${bucketStart.toFixed(0)}] ${bucket.join(' ')}`);

  return lines.join('\n');
}

export interface SelectOptions {
  transcript: Transcript;
  /** Upper bound on how many clips to take from one video. */
  maxSegments?: number;
  title?: string;
}

/**
 * How much transcript goes into one request.
 *
 * A full 35-minute transcript is roughly 15k tokens, over the free tier's
 * per-minute allowance in a single call. Windowing fixes that and pays a
 * second dividend: the model reads a shorter passage more carefully, so the
 * spans it returns land closer to where the moment actually starts.
 */
const WINDOW_SECONDS = 480;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function selectSegments(opts: SelectOptions): Promise<Segment[]> {
  const { transcript, maxSegments = 8, title } = opts;
  if (transcript.words.length === 0) return [];

  const windows = splitWindows(transcript.durationSeconds);
  const perWindow = Math.max(1, Math.ceil(maxSegments / windows.length));

  const all: Segment[] = [];
  for (const [index, w] of windows.entries()) {
    const words = transcript.words.filter((x) => x.start >= w.from && x.start < w.to);
    if (words.length < 40) continue;

    // Spread requests out: the free tier meters tokens per minute, and a
    // long video would otherwise burn the whole allowance in one burst.
    if (index > 0) await sleep(Number(process.env.LLM_WINDOW_DELAY_MS || 20_000));

    const segments = await selectFromWindow(
      timedTranscript(words),
      perWindow,
      title,
    );
    all.push(...segments);
  }

  return sanitize(all, transcript.durationSeconds, maxSegments);
}

function splitWindows(duration: number): Array<{ from: number; to: number }> {
  const windows: Array<{ from: number; to: number }> = [];
  for (let from = 0; from < duration; from += WINDOW_SECONDS) {
    windows.push({ from, to: Math.min(from + WINDOW_SECONDS, duration) });
  }
  return windows;
}

async function selectFromWindow(
  timed: string,
  maxSegments: number,
  title?: string,
): Promise<Segment[]> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is not set');

  const baseUrl = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
  const model = process.env.LLM_MODEL || 'openai/gpt-oss-120b';

  const user = [
    title ? `Video: ${title}` : null,
    `Return at most ${maxSegments} clips from this passage, each between`,
    `${MIN_SEGMENT_SECONDS} and ${MAX_SEGMENT_SECONDS} seconds. Return none if`,
    'nothing here stands alone.',
    '',
    'Transcript, each line prefixed with its start time in seconds:',
    timed,
  ]
    .filter(Boolean)
    .join('\n');

  const body = JSON.stringify({
    model,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${SYSTEM}\n\nSchema:\n${JSON.stringify(SCHEMA)}` },
      { role: 'user', content: user },
    ],
  });

  // One retry on a rate limit; the API tells us how long to wait.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('retry-after') ?? 20) * 1000;
      await sleep(Math.min(wait, 60_000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Segment selection failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = z
      .object({ segments: z.array(SegmentSchema).default([]) })
      .parse(JSON.parse(content));
    return parsed.segments;
  }

  return [];
}

/**
 * The model picks moments well but is loose with arithmetic: it returns spans
 * that run past the video, overlap each other, or are two seconds long. None of
 * that is worth another round trip — it is cheaper to fix here.
 */
export function sanitize(
  segments: Segment[],
  durationSeconds: number,
  maxSegments: number,
): Segment[] {
  const cleaned = segments
    .map((s) => ({
      ...s,
      start: Math.max(0, Math.min(s.start, durationSeconds)),
      end: Math.max(0, Math.min(s.end, durationSeconds)),
      hook: s.hook.trim(),
    }))
    // Adverts read well from a transcript — self-contained, ending on a call
    // to action — which is exactly why they have to be excluded explicitly.
    // A keyword list gets this backwards: real sponsor reads avoid the word
    // "advert", while genuine reporting about an ad deal is full of it.
    .filter((s) => !s.sponsor)
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SECONDS && s.hook.length > 0)
    .map((s) => ({
      ...s,
      end: Math.min(s.end, s.start + MAX_SEGMENT_SECONDS),
    }))
    .sort((a, b) => a.start - b.start);

  // Two clips covering the same moment publish the same content twice.
  const kept: Segment[] = [];
  for (const s of cleaned) {
    const previous = kept[kept.length - 1];
    if (previous && s.start < previous.end) continue;
    kept.push(s);
  }

  return kept.slice(0, maxSegments);
}
