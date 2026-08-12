import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

export class FfmpegError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) =>
      reject(new FfmpegError(`Failed to spawn ${bin}: ${err.message}`, stderr)),
    );

    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      // ffmpeg puts everything useful on stderr, so surface its tail.
      else reject(new FfmpegError(`${bin} exited ${code}`, stderr.slice(-4000)));
    });
  });
}

export const ffmpeg = (args: string[]) => run(ffmpegPath(), args);
export const ffprobe = (args: string[]) => run(ffprobePath(), args);

export interface MediaInfo {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
}

export async function probe(file: string): Promise<MediaInfo> {
  const raw = await ffprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);

  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
  };

  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found');

  const [num, den] = (video.avg_frame_rate ?? '30/1').split('/').map(Number);

  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: parsed.streams?.some((s) => s.codec_type === 'audio') ?? false,
    fps: den ? num / den : 30,
  };
}

/** Creates a scratch directory and removes it once `fn` settles. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const base = process.env.MEDIA_TMP_DIR || tmpdir();
  const dir = await mkdtemp(path.join(base, 'igauto-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
