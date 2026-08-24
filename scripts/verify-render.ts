/**
 * Renders a synthetic clip through the real remix pipeline.
 *
 * The ffmpeg filter chain is the most failure-prone part of the system —
 * drawtext has its own escaping rules, and a bad one only shows up at render
 * time. Run this after touching lib/media/, before pushing.
 *
 *   npm run verify:render
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { ffmpeg, probe, withTempDir, type MediaInfo } from '@/lib/media/ffmpeg';
import { hammingDistance, videoPhash } from '@/lib/media/phash';
import { remix } from '@/lib/media/transform';

// The media helpers read these at call time, so setting them here is enough.
// Uses the bundled binaries unless the environment already provides ffmpeg.
process.env.FFMPEG_PATH ||= (ffmpegStatic as unknown as string) ?? 'ffmpeg';
process.env.FFPROBE_PATH ||= ffprobeStatic.path;

const SOURCE_SECONDS = 25;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

async function main(): Promise<void> {
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'source.mp4');

    // Landscape with audio: exercises the crop path and the audio passthrough.
    await ffmpeg([
      '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${SOURCE_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      source,
    ]);

    console.log('source  ', describe(await probe(source)));

    const { outputPath, info } = await remix(source, dir, {
      // Diacritics, an em dash, an apostrophe and a colon — every drawtext
      // escaping rule in one string.
      hookText: "Zaczynałem od 40kg — dziś 120kg: zobacz jak to zrobił",
      brandHandle: '@mojekonto',
      // Campaign logos are burned in, so the overlay path has to be exercised
      // too — it moves the whole chain into filter_complex.
      logoPath: process.env.CAMPAIGN_LOGO
        ? path.resolve(process.cwd(), process.env.CAMPAIGN_LOGO)
        : undefined,
    });

    const { size } = await stat(outputPath);
    console.log('remix   ', describe(info), `${(size / 1024 / 1024).toFixed(2)}MB`);

    const remixHash = await videoPhash(outputPath, info.durationSeconds, dir);
    const sourceHash = await videoPhash(source, SOURCE_SECONDS, dir);
    console.log(
      'phash   ',
      remixHash,
      `distance to source: ${hammingDistance(remixHash, sourceHash)}`,
    );

    const problems: string[] = [];
    if (info.width !== 1080 || info.height !== 1920) problems.push('not 1080x1920');
    if (!info.hasAudio) problems.push('audio track missing');
    if (size > MAX_OUTPUT_BYTES) problems.push('over the 50MB storage limit');

    if (problems.length > 0) {
      console.error('\nFAILED:', problems.join(', '));
      process.exit(1);
    }

    // A frame kept for eyeballing: layout bugs — a hook overlapping the logo,
    // a mark keyed to the wrong colour — are invisible in the checks above.
    const frame = path.join(process.cwd(), 'verify-frame.png');
    await ffmpeg(['-y', '-i', outputPath, '-ss', '2', '-vframes', '1', frame]);
    console.log('frame   ', frame);

    console.log('\nOK — remix pipeline works end to end');
  });
}

function describe(info: MediaInfo): string {
  return `${info.width}x${info.height} ${info.durationSeconds.toFixed(1)}s audio=${info.hasAudio}`;
}

main().catch((err: Error & { stderr?: string }) => {
  console.error('FAILED:', err.message);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
});
