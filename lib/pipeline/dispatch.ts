import { enqueueDueSources, ingestSource } from '@/lib/ingest';
import { ingestYouTubeChannel } from '@/lib/ingest/youtube';
import { recomputeBaselines, scorePost } from '@/lib/scoring';
import { admin } from '@/lib/supabase/admin';
import type { Job, Source } from '@/lib/types/db';
import { cleanup } from './cleanup';
import { clipVideo } from './clip';
import { collectOwnMetrics, pushPublication, scheduleRendition } from './publish';
import { renderPost } from './render';

/** Runs one claimed job. Throwing hands it back to the queue for retry. */
export async function dispatch(job: Job): Promise<unknown> {
  const payload = job.payload as Record<string, string | undefined>;

  switch (job.kind) {
    case 'ingest': {
      const { data, error } = await admin()
        .from('sources')
        .select('*')
        .eq('id', payload.sourceId!)
        .single();
      if (error) throw error;

      const source = data as Source;
      // Everything from YouTube takes a different route: no scoring, straight
      // to clipping. See lib/ingest/youtube.ts for why.
      //
      // Matched on the prefix rather than listed kind by kind. The list was
      // the bug: two source kinds were added, wired all the way through
      // ingest, and then silently failed here for a day because this line was
      // never updated.
      return source.kind.startsWith('yt_')
        ? ingestYouTubeChannel(source)
        : ingestSource(source);
    }

    case 'score':
      return scorePost(payload.postId!);

    case 'render':
      return renderPost(payload.postId!);

    case 'publish':
      // One job kind, two phases: booking a slot, then pushing at that slot.
      return payload.publicationId
        ? pushPublication(payload.publicationId)
        : scheduleRendition(payload.renditionId!, payload.accountId!);

    case 'collect_own_metrics':
      return collectOwnMetrics(payload.publicationId!);

    case 'recompute_baselines':
      return recomputeBaselines();

    case 'cleanup':
      return cleanup();

    case 'clip':
      return clipVideo(payload.postId!);

    default: {
      const exhaustive: never = job.kind;
      throw new Error(`Unhandled job kind: ${exhaustive}`);
    }
  }
}

export { enqueueDueSources };
