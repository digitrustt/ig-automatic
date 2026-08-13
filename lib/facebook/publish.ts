import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { graphPost } from '@/lib/instagram/graph';

export interface FacebookReelInput {
  pageId: string;
  accessToken: string;
  /** Local file. Facebook uploads bytes rather than fetching a URL. */
  videoPath: string;
  description: string;
}

export interface FacebookReelResult {
  videoId: string;
  permalink: string | null;
}

interface StartResponse {
  video_id: string;
  upload_url: string;
}

/**
 * Publishes a Reel to a Facebook Page.
 *
 * Unlike Instagram, which fetches the file from a URL we hand it, Facebook
 * wants the bytes pushed to a dedicated upload host in a separate request.
 * Hence three phases: reserve an id, send the file, then publish it.
 */
export async function publishFacebookReel(
  input: FacebookReelInput,
): Promise<FacebookReelResult> {
  const { pageId, accessToken, videoPath, description } = input;

  const start = await graphPost<StartResponse>(
    `/${pageId}/video_reels`,
    accessToken,
    { upload_phase: 'start' },
  );

  await uploadBytes(start.upload_url, accessToken, videoPath);

  await graphPost(`/${pageId}/video_reels`, accessToken, {
    video_id: start.video_id,
    upload_phase: 'finish',
    video_state: 'PUBLISHED',
    description,
  });

  return {
    videoId: start.video_id,
    permalink: `https://www.facebook.com/reel/${start.video_id}`,
  };
}

/**
 * Streams the file to Facebook's upload host.
 *
 * This endpoint is not the Graph API: it takes the token in an `OAuth` header
 * rather than a query parameter, and the body is the raw file rather than a
 * form. Sending it the Graph way fails with an unhelpful error.
 */
async function uploadBytes(
  uploadUrl: string,
  accessToken: string,
  videoPath: string,
): Promise<void> {
  const { size } = await stat(videoPath);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${accessToken}`,
      offset: '0',
      file_size: String(size),
      'content-type': 'application/octet-stream',
    },
    body: Readable.toWeb(createReadStream(videoPath)) as ReadableStream,
    // Required by fetch when the body is a stream.
    duplex: 'half',
    signal: AbortSignal.timeout(10 * 60_000),
  } as RequestInit & { duplex: 'half' });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook upload failed (${res.status}): ${body.slice(0, 300)}`);
  }
}
