import { NextResponse } from 'next/server';

/**
 * Cron endpoints enqueue work, so they must not be open to the internet.
 * Vercel Cron sends the secret as a bearer token.
 */
export function assertCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 500 });
  }

  const header = request.headers.get('authorization');
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return null;
}
