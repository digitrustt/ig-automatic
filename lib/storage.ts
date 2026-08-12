import { readFile } from 'node:fs/promises';
import { admin } from '@/lib/supabase/admin';

export const RENDITIONS_BUCKET = 'renditions';

/**
 * Instagram fetches the video from this URL itself, so it must stay reachable
 * for the whole publish window — well past the few seconds our upload takes.
 */
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

export interface UploadedRendition {
  storagePath: string;
  publicUrl: string;
}

export async function uploadRendition(
  localPath: string,
  key: string,
): Promise<UploadedRendition> {
  const body = await readFile(localPath);

  const { error } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .upload(key, body, { contentType: 'video/mp4', upsert: true });
  if (error) throw error;

  const { data, error: signError } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  if (signError) throw signError;

  return { storagePath: key, publicUrl: data.signedUrl };
}

/** Re-signs a stored rendition whose URL has expired since it was rendered. */
export async function refreshSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}
