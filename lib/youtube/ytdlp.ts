import path from 'node:path';
import { run } from '@/lib/media/ffmpeg';

function ytdlpPath(): string {
  return process.env.YTDLP_PATH || 'yt-dlp';
}

/**
 * yt-dlp shells out to ffmpeg for merging streams and for cutting on
 * keyframes, and it finds it on PATH — it does not read our FFMPEG_PATH. When
 * we point at a bundled binary instead of a system install, it has to be told
 * where to look or every section download fails.
 */
function ffmpegLocation(): string[] {
  const ffmpeg = process.env.FFMPEG_PATH;
  if (!ffmpeg || ffmpeg === 'ffmpeg') return [];
  return ['--ffmpeg-location', path.dirname(ffmpeg)];
}

/**
 * YouTube serves a bot check to datacenter addresses, which is every CI
 * runner. A logged-in session gets through; metadata still resolves without
 * one, so only the download paths need this.
 *
 * The cookies belong to a real Google account and grant full access to it —
 * use a throwaway, keep the file out of the repo, and expect to replace it
 * every few weeks as the session rotates.
 */
function cookies(): string[] {
  const file = process.env.YTDLP_COOKIES_FILE;
  return file ? ['--cookies', file] : [];
}

/**
 * YouTube hides its media URLs behind a JavaScript challenge. Solving it needs
 * a JS runtime (Deno) *and* a solver script, and yt-dlp will not fetch that
 * script unless asked — without this flag it reports "n challenge solving
 * failed" and offers nothing but storyboard images, which reads like a format
 * problem rather than an authentication one.
 */
function challengeSolver(): string[] {
  return ['--remote-components', 'ejs:github'];
}

/**
 * Asks YouTube for titles in the channel's own language.
 *
 * YouTube auto-translates titles to match where the request comes from, and CI
 * runners are American — so a Polish channel came back as "KARO AND ERYK'S
 * PICNIC!" instead of "PIKNIK KARO I ERYKA!". That title is what the selection
 * prompt is told the video is about, and what gets stored as the post's
 * caption, so the translation was quietly degrading both.
 *
 * There is no code for "leave it alone"; naming the language is the way to ask.
 */
function preferredLanguage(): string[] {
  return ['--extractor-args', `youtube:lang=${process.env.YTDLP_LANG || 'pl'}`];
}

export type ChannelOrder = 'latest' | 'popular';

export interface ChannelVideo {
  videoId: string;
  title: string;
  durationSeconds: number;
  viewCount: number | null;
  uploadedAt: string | null;
  url: string;
}

/**
 * Lists a playlist the same way, metadata only.
 *
 * A playlist is somebody else's edit of a channel — a best-of, a themed run —
 * and often the only place that material exists as a set. Ordering is theirs,
 * not the audience's, so nothing is inferred from position here.
 */
export async function listPlaylistVideos(
  playlistId: string,
  limit = 50,
): Promise<ChannelVideo[]> {
  return listUrl(`https://www.youtube.com/playlist?list=${playlistId}`, limit);
}

/**
 * Reads one video's metadata.
 *
 * Does not go through the listing path, and cannot. A channel or playlist page
 * is public metadata that yt-dlp reads flat and unauthenticated, but resolving
 * a single video is a full extraction: YouTube serves it the bot gate and the
 * JavaScript challenge, exactly as it does a download. So this needs the
 * session and the solver, and must not be flattened — measured against a live
 * video, every other combination fails, each with a different error.
 *
 * The URL is rebuilt from the id rather than used as pasted: a link copied
 * from the YouTube app carries the playlist it was playing inside, and yt-dlp
 * would happily walk all of it.
 */
export async function describeVideo(videoId: string): Promise<ChannelVideo | null> {
  const stdout = await run(ytdlpPath(), [
    ...cookies(),
    ...challengeSolver(),
    ...preferredLanguage(),
    '--skip-download',
    '--print', '%(.{id,title,duration,view_count,upload_date,timestamp})j',
    '--no-warnings',
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  const [video] = parseEntries(stdout);
  return video ?? null;
}

/** yt-dlp's `--print` output, one JSON object per line. */
interface FlatEntry {
  id: string;
  title?: string;
  duration?: number;
  view_count?: number;
  upload_date?: string; // YYYYMMDD
  timestamp?: number;
}

/**
 * Lists a channel's most recent uploads without touching the videos
 * themselves — metadata only, so it is fast and cheap enough to poll.
 */
export async function listChannelVideos(
  handle: string,
  limit = 5,
  order: ChannelOrder = 'latest',
): Promise<ChannelVideo[]> {
  // Polish handles carry diacritics — @DlaPieniędzy resolves only once the
  // non-ASCII characters are percent-encoded.
  const channel = `@${encodeURIComponent(handle.replace(/^@/, ''))}`;

  // YouTube exposes the archive ranked by view count through the same tab,
  // which turns years of uploads into a queue the audience already sorted.
  const url =
    order === 'popular'
      ? `https://www.youtube.com/${channel}/videos?view=0&sort=p&flow=grid`
      : `https://www.youtube.com/${channel}/videos`;

  return listUrl(url, limit);
}

async function listUrl(url: string, limit: number): Promise<ChannelVideo[]> {
  const stdout = await run(ytdlpPath(), [
    ...preferredLanguage(),
    '--flat-playlist',
    '--playlist-end', String(limit),
    '--print', '%(.{id,title,duration,view_count,upload_date,timestamp})j',
    '--no-warnings',
    url,
  ]);

  return parseEntries(stdout);
}

function parseEntries(stdout: string): ChannelVideo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FlatEntry)
    .filter((e) => e.id)
    .map((e) => ({
      videoId: e.id,
      title: e.title ?? '',
      durationSeconds: e.duration ?? 0,
      viewCount: e.view_count ?? null,
      uploadedAt: toIsoDate(e),
      url: `https://www.youtube.com/watch?v=${e.id}`,
    }));
}

function toIsoDate(entry: FlatEntry): string | null {
  if (entry.timestamp) return new Date(entry.timestamp * 1000).toISOString();
  if (!entry.upload_date) return null;

  const d = entry.upload_date;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`;
}

export interface DownloadSectionOptions {
  url: string;
  dir: string;
  startSeconds: number;
  endSeconds: number;
  /** Cap resolution; 720p is plenty once cropped to a phone-sized frame. */
  maxHeight?: number;
  filename?: string;
}

/**
 * Fetches only the requested span of a video.
 *
 * Downloading a 45-minute file to keep 40 seconds of it wastes bandwidth and
 * time on every clip; `--download-sections` asks the CDN for just that range.
 * `--force-keyframes-at-cuts` re-encodes the boundaries so the clip starts on
 * the frame we asked for rather than the nearest keyframe, which can otherwise
 * be seconds away and cut the first words off.
 */
export async function downloadSection(
  opts: DownloadSectionOptions,
): Promise<string> {
  const output = path.join(opts.dir, opts.filename ?? 'section.mp4');
  const height = opts.maxHeight ?? 720;

  await run(ytdlpPath(), [
    ...ffmpegLocation(),
    ...cookies(),
    ...challengeSolver(),
    '--download-sections', `*${fmt(opts.startSeconds)}-${fmt(opts.endSeconds)}`,
    '--force-keyframes-at-cuts',
    '-f', `bv*[height<=${height}]+ba/b[height<=${height}]`,
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '-o', output,
    opts.url,
  ]);

  return output;
}

/** Pulls just the audio track, for transcription. */
export async function downloadAudio(url: string, dir: string): Promise<string> {
  const output = path.join(dir, 'audio.m4a');

  await run(ytdlpPath(), [
    ...ffmpegLocation(),
    ...cookies(),
    ...challengeSolver(),
    '-f', 'ba[ext=m4a]/ba',
    '--no-warnings',
    '-o', output,
    url,
  ]);

  return output;
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
