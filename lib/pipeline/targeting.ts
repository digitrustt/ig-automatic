import { admin } from '@/lib/supabase/admin';
import type { Account } from '@/lib/types/db';

/** An account with this niche publishes winners from every niche. */
export const ALL_NICHES = '*';

/**
 * Finds the account a piece of content should be published to.
 *
 * Niches exist to keep scoring honest — a z-score is only meaningful against
 * posts of a comparable kind, and animal clips and engineering clips have
 * engagement norms orders of magnitude apart. A general-interest account still
 * wants the winner from every one of those baselines, which is what the
 * wildcard expresses: score per niche, publish across all of them.
 */
export async function accountForNiche(niche: string): Promise<Account | null> {
  const accounts = await accountsForNiche(niche);
  return accounts.find((a) => a.platform === 'instagram') ?? accounts[0] ?? null;
}

/**
 * Every account a clip should go to — one per platform.
 *
 * The same rendition is published to Instagram and to a Facebook Page, so the
 * fan-out happens here rather than in each pipeline. Within a platform a
 * niche-specific account still beats a catch-all one; across platforms all of
 * them get it.
 */
export async function accountsForNiche(niche: string): Promise<Account[]> {
  const { data, error } = await admin()
    .from('accounts')
    .select('*')
    .eq('enabled', true)
    .in('niche', [niche, ALL_NICHES]);
  if (error) throw error;

  const byPlatform = new Map<string, Account>();
  for (const account of (data ?? []) as Account[]) {
    const current = byPlatform.get(account.platform);
    // An account dedicated to this niche outranks a catch-all one.
    if (!current || (current.niche === ALL_NICHES && account.niche === niche)) {
      byPlatform.set(account.platform, account);
    }
  }

  return [...byPlatform.values()];
}

/** Last 20 hooks we published, so the generator does not repeat a formula. */
export async function recentHooks(accountId: string): Promise<string[]> {
  const { data, error } = await admin()
    .from('publications')
    .select('renditions(hook_text)')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  return (data as unknown as Array<{ renditions: { hook_text: string | null } | null }>)
    .map((row) => row.renditions?.hook_text)
    .filter((h): h is string => Boolean(h));
}
