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

/**
 * Signs many paths in one round trip.
 *
 * The preview grid needs a URL per clip; signing them individually would be a
 * request each, and the page would spend longer waiting on Supabase than on
 * rendering. Paths that no longer exist are skipped rather than throwing —
 * retention deletes files while their rows survive.
 */
export async function signMany(
  storagePaths: string[],
  ttlSeconds = 3600,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (storagePaths.length === 0) return urls;

  const { data, error } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .createSignedUrls(storagePaths, ttlSeconds);
  if (error) throw error;

  for (const entry of data ?? []) {
    if (entry.signedUrl && entry.path) urls.set(entry.path, entry.signedUrl);
  }
  return urls;
}

/** Re-signs a stored rendition whose URL has expired since it was rendered. */
export async function refreshSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}
