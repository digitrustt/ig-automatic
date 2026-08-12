import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

/** IG rejects anything above 1GB; we stay well under it. */
const MAX_BYTES = 300 * 1024 * 1024;

export async function downloadTo(
  url: string,
  dir: string,
  filename = 'source.mp4',
): Promise<string> {
  const res = await fetch(url, {
    headers: {
      // CDNs serve 403 to clients without a browser-shaped UA.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`Download failed (${res.status}) for ${url.slice(0, 120)}`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`Media too large: ${declared} bytes`);
  }
  if (!res.body) throw new Error('Empty response body');

  const target = path.join(dir, filename);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));

  return target;
}
