import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from '@/lib/media/ffmpeg';

export interface Word {
  word: string;
  start: number;
  end: number;
}

export interface Transcript {
  language: string;
  durationSeconds: number;
  text: string;
  words: Word[];
}

/** Groq's upload ceiling for the free tier. */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/**
 * Speech is intelligible far below music-grade audio, and the API charges by
 * duration rather than bitrate, so downmixing to 16kHz mono keeps a 45-minute
 * video comfortably under the upload limit.
 */
export async function extractAudio(videoPath: string, dir: string): Promise<string> {
  const output = path.join(dir, 'speech.mp3');

  await ffmpeg([
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '48k',
    output,
  ]);

  return output;
}

/**
 * Transcribes with word-level timestamps.
 *
 * The timestamps are what make everything downstream possible: they let the
 * model pick a segment by its content and let us burn captions that land on
 * the syllable.
 */
export async function transcribe(
  audioPath: string,
  language = 'pl',
): Promise<Transcript> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is not set');

  const { size } = await stat(audioPath);
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      }MB upload limit`,
    );
  }

  const baseUrl = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
  const model = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';

  const form = new FormData();
  const file = await fileFrom(audioPath);
  form.set('file', file);
  form.set('model', model);
  form.set('language', language);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  // The free tier meters by the minute and a long video is a large single
  // request, so a rate limit here is routine rather than exceptional. The API
  // says how long to wait; waiting is much cheaper than re-downloading the
  // audio on a fresh attempt.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(10 * 60_000),
    });

    if (res.status !== 429) break;

    const wait = Number(res.headers.get('retry-after') ?? 30) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
  }

  if (!res || !res.ok) {
    const body = res ? await res.text() : 'no response';
    throw new Error(
      `Transcription failed (${res?.status ?? 0}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as {
    language?: string;
    duration?: number;
    text?: string;
    words?: Array<{ word: string; start: number; end: number }>;
  };

  return {
    language: payload.language ?? language,
    durationSeconds: payload.duration ?? 0,
    text: payload.text ?? '',
    words: payload.words ?? [],
  };
}

/** Reads a file into the multipart body without loading it twice. */
async function fileFrom(filePath: string): Promise<File> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) {
    chunks.push(chunk as Buffer);
  }
  return new File([new Uint8Array(Buffer.concat(chunks))], path.basename(filePath), {
    type: 'audio/mpeg',
  });
}

/** Renders a window of the transcript as timestamped lines for a prompt. */
export function windowText(words: Word[], from: number, to: number): string {
  return words
    .filter((w) => w.start >= from && w.start < to)
    .map((w) => w.word)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
