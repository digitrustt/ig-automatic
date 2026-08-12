import { NextResponse } from 'next/server';
import { assertCron } from '@/lib/cron-auth';
import { errorMessage } from '@/lib/errors';
import { enqueueDueSources } from '@/lib/ingest';
import { enqueueScorable } from '@/lib/scoring';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The heartbeat: queues source polls that are due and re-scores everything
 * still in flight. Does no heavy work itself — the worker drains the queue.
 */
export async function GET(request: Request) {
  const denied = assertCron(request);
  if (denied) return denied;

  try {
    const [sources, scorable] = await Promise.all([
      enqueueDueSources(),
      enqueueScorable(),
    ]);

    return NextResponse.json({ ok: true, sourcesQueued: sources, postsQueued: scorable });
  } catch (err) {
    const message = errorMessage(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
