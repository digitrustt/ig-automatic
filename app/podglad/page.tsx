import Link from 'next/link';
import { signMany } from '@/lib/storage';
import { admin } from '@/lib/supabase/admin';
import { ClipCard, type ClipView } from './clip-card';

export const dynamic = 'force-dynamic';

/** Rows the query returns, with its two embedded relations. */
interface RenditionRow {
  id: string;
  storage_path: string | null;
  hook_text: string | null;
  caption: string | null;
  hashtags: string[] | null;
  duration_seconds: number | null;
  start_seconds: number | null;
  end_seconds: number | null;
  created_at: string;
  posts: { caption: string | null; author_handle: string | null; permalink: string | null } | null;
  publications: Array<{
    status: string;
    scheduled_for: string | null;
    accounts: { handle: string } | null;
  }>;
}

const PAGE_SIZE = 24;

async function loadClips(): Promise<ClipView[]> {
  const { data, error } = await admin()
    .from('renditions')
    .select(
      'id, storage_path, hook_text, caption, hashtags, duration_seconds, start_seconds, end_seconds, created_at, posts(caption, author_handle, permalink), publications(status, scheduled_for, accounts(handle))',
    )
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RenditionRow[];

  // One signing round trip for the whole page rather than one per card.
  const paths = rows.map((r) => r.storage_path).filter((p): p is string => Boolean(p));
  const urls = await signMany(paths);

  return rows.map((r) => {
    const publication = r.publications?.[0];
    return {
      id: r.id,
      videoUrl: r.storage_path ? (urls.get(r.storage_path) ?? null) : null,
      hook: r.hook_text,
      caption: r.caption,
      hashtags: r.hashtags ?? [],
      durationSeconds: r.duration_seconds,
      startSeconds: r.start_seconds,
      endSeconds: r.end_seconds,
      sourceTitle: r.posts?.caption ?? null,
      sourceHandle: r.posts?.author_handle ?? null,
      sourceUrl: r.posts?.permalink ?? null,
      status: publication?.status ?? 'w kolejce',
      scheduledFor: publication?.scheduled_for ?? null,
      accountHandle: publication?.accounts?.handle ?? null,
    };
  });
}

export default async function Preview() {
  const clips = await loadClips();

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Podgląd</h1>
          <p className="mt-1 text-sm text-muted">
            Gotowe klipy dokładnie w takiej postaci, w jakiej trafią na konto
          </p>
        </div>
        <Link
          href="/"
          className="text-sm underline underline-offset-4 hover:no-underline"
        >
          ← dashboard
        </Link>
      </header>

      {clips.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted">
          Nic jeszcze nie wyrenderowano.
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{clips.length} klipów</p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
