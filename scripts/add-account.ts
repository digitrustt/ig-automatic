/**
 * Registers a publishing account from a freshly minted Meta token.
 *
 * Every new account arrives the same way: a short-lived token from the Graph
 * API Explorer that expires within the hour. What the pipeline needs instead is
 * a Page token, which never expires — and getting one means exchanging the
 * short-lived token for a long-lived one (which needs the app secret), then
 * reading the Page's own token off it. Doing that by hand is four calls and two
 * chances to paste the wrong string into the database.
 *
 *   npx tsx scripts/add-account.ts --app-id=... --app-secret=... \
 *     --token=... --niche=newsy [--limit=8] [--instagram-only]
 */
import { admin } from '@/lib/supabase/admin';

const GRAPH = `https://graph.facebook.com/${process.env.IG_GRAPH_VERSION || 'v21.0'}`;

interface Page {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username: string };
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body;
}

async function main() {
  const appId = arg('app-id');
  const appSecret = arg('app-secret');
  const token = arg('token');
  const niche = arg('niche');
  const limit = Number(arg('limit') || 8);
  const instagramOnly = process.argv.includes('--instagram-only');

  if (!appId || !appSecret || !token || !niche) {
    throw new Error(
      'Wymagane: --app-id --app-secret --token --niche (opcjonalnie --limit, --instagram-only)',
    );
  }

  const { access_token: longLived } = await graph<{ access_token: string }>(
    'oauth/access_token',
    {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: token,
    },
  );

  const { data: pages } = await graph<{ data: Page[] }>('me/accounts', {
    access_token: longLived,
    fields: 'id,name,access_token,instagram_business_account{id,username}',
  });

  if (pages.length === 0) {
    throw new Error(
      'Token nie widzi zadnej strony. Brakuje uprawnien instagram_basic i pages_show_list — dodaj je w Graph API Explorer i wygeneruj token na nowo.',
    );
  }

  for (const page of pages) {
    const ig = page.instagram_business_account;

    // A Page without a linked Instagram account cannot carry Reels, and the
    // pipeline has nothing else to do with it.
    if (!ig && !instagramOnly) {
      console.log(`  pomijam ${page.name}: brak konta na Instagramie`);
      continue;
    }

    const rows = [
      ig && {
        platform: 'instagram',
        handle: ig.username,
        platform_user_id: ig.id,
        access_token: page.access_token,
        niche,
        daily_post_limit: limit,
        enabled: true,
      },
      !instagramOnly && {
        platform: 'facebook',
        handle: page.name,
        platform_user_id: page.id,
        access_token: page.access_token,
        niche,
        daily_post_limit: limit,
        enabled: true,
      },
    ].filter(Boolean);

    const { error } = await admin().from('accounts').upsert(rows as never[], {
      onConflict: 'platform,platform_user_id',
    });
    if (error) throw error;

    console.log(`  + ${ig?.username ?? page.name} (${niche}, ${limit}/dzien)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
