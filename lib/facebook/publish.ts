import { readFile } from 'node:fs/promises';
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
 * Sends the file to Facebook's upload host.
 *
 * This endpoint is not the Graph API and does not behave like it: the token
 * goes in an `OAuth` header rather than a query parameter, and the body is raw
 * bytes rather than a form.
 *
 * It also insists on knowing the length up front — both `Content-Length` and
 * `X-Entity-Length` — so the file is buffered rather than streamed. A stream
 * makes fetch use chunked encoding, which this endpoint rejects. Buffering is
 * safe here because renditions are capped at 50MB before they are ever stored.
 */
async function uploadBytes(
  uploadUrl: string,
  accessToken: string,
  videoPath: string,
): Promise<void> {
  const bytes = await readFile(videoPath);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${accessToken}`,
      offset: '0',
      file_size: String(bytes.byteLength),
      'content-length': String(bytes.byteLength),
      'X-Entity-Length': String(bytes.byteLength),
      'X-Entity-Name': 'reel.mp4',
      'X-Entity-Type': 'video/mp4',
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook upload failed (${res.status}): ${body.slice(0, 300)}`);
  }
}
