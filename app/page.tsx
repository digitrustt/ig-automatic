import { getConfig } from '@/lib/config';
import { admin } from '@/lib/supabase/admin';
import type { Config, Post, Publication, Rendition } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

type Candidate = Pick<
  Post,
  'id' | 'niche' | 'author_handle' | 'permalink' | 'score' | 'status' | 'published_at'
>;

type UpcomingRow = Pick<Publication, 'id' | 'scheduled_for' | 'status'> & {
  renditions: Pick<Rendition, 'hook_text'> | null;
  accounts: { handle: string } | null;
};

type RecentRow = Pick<Publication, 'id' | 'published_at' | 'permalink' | 'status'> & {
  renditions: Pick<Rendition, 'hook_text'> | null;
  publication_metrics: Array<{ views: number | null; likes: number | null }>;
};

async function loadDashboard() {
  const config = await getConfig();
  const db = admin();

  const [counts, candidates, upcoming, recent] = await Promise.all([
    statusCounts(),
    db
      .from('posts')
      .select('id, niche, author_handle, permalink, score, status, published_at')
      .in('status', ['tracking', 'selected', 'rendering', 'ready'])
      .not('score', 'is', null)
      .order('score', { ascending: false })
      .limit(15),
    db
      .from('publications')
      .select('id, scheduled_for, status, renditions(hook_text), accounts(handle)')
      .in('status', ['scheduled', 'publishing'])
      .order('scheduled_for', { ascending: true })
      .limit(10),
    db
      .from('publications')
      .select(
        'id, published_at, permalink, status, renditions(hook_text), publication_metrics(views, likes)',
      )
      .in('status', ['published', 'skipped_shadow', 'failed'])
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  return {
    config,
    counts,
    candidates: (candidates.data ?? []) as Candidate[],
    upcoming: (upcoming.data ?? []) as unknown as UpcomingRow[],
    recent: (recent.data ?? []) as unknown as RecentRow[],
  };
}

async function statusCounts(): Promise<Record<string, number>> {
  const statuses = ['tracking', 'selected', 'ready', 'published', 'rejected'] as const;

  const entries = await Promise.all(
    statuses.map(async (status) => {
      const { count } = await admin()
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      return [status, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export default async function Dashboard() {
  const { config, counts, candidates, upcoming, recent } = await loadDashboard();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">ig-automatic</h1>
        <p className="mt-1 text-sm text-muted">
          Wykrywanie trendów, remiks i publikacja Reelsów
        </p>
      </header>

      <ModeBanner config={config} />

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries(counts).map(([status, count]) => (
          <div key={status} className="rounded-lg border border-border bg-card p-4">
            <div className="text-2xl font-semibold tabular-nums">{count}</div>
            <div className="mt-0.5 text-xs text-muted">{status}</div>
          </div>
        ))}
      </section>

      <Section title="Kandydaci wg score" subtitle="z-score prędkości względem baseline'u niszy">
        {candidates.length === 0 ? (
          <Empty>Brak ocenionych postów — baseline potrzebuje 30 próbek na niszę.</Empty>
        ) : (
          <Table headers={['Score', 'Nisza', 'Autor', 'Status', '']}>
            {candidates.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <Td className="font-medium tabular-nums">{c.score?.toFixed(2)}</Td>
                <Td>{c.niche}</Td>
                <Td className="text-muted">{c.author_handle ?? '—'}</Td>
                <Td>
                  <Badge>{c.status}</Badge>
                </Td>
                <Td>
                  {c.permalink && (
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline underline-offset-2 hover:no-underline"
                    >
                      źródło
                    </a>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Zaplanowane publikacje">
        {upcoming.length === 0 ? (
          <Empty>Nic w kolejce.</Empty>
        ) : (
          <Table headers={['Termin', 'Konto', 'Hook', 'Status']}>
            {upcoming.map((p) => (
              <tr key={p.id} className="border-t border-border">
                <Td className="tabular-nums">{formatDate(p.scheduled_for)}</Td>
                <Td className="text-muted">@{p.accounts?.handle ?? '—'}</Td>
                <Td className="max-w-xs truncate">{p.renditions?.hook_text ?? '—'}</Td>
                <Td>
                  <Badge>{p.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Ostatnie publikacje" subtitle="wyniki wracają do scoringu">
        {recent.length === 0 ? (
          <Empty>Jeszcze nic nie poszło w świat.</Empty>
        ) : (
          <Table headers={['Data', 'Hook', 'Wyświetlenia', 'Polubienia', 'Status']}>
            {recent.map((p) => {
              const latest = p.publication_metrics?.[0];
              return (
                <tr key={p.id} className="border-t border-border">
                  <Td className="tabular-nums">{formatDate(p.published_at)}</Td>
                  <Td className="max-w-xs truncate">
                    {p.permalink ? (
                      <a
                        href={p.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:no-underline"
                      >
                        {p.renditions?.hook_text ?? '—'}
                      </a>
                    ) : (
                      (p.renditions?.hook_text ?? '—')
                    )}
                  </Td>
                  <Td className="tabular-nums">{latest?.views?.toLocaleString('pl') ?? '—'}</Td>
                  <Td className="tabular-nums">{latest?.likes?.toLocaleString('pl') ?? '—'}</Td>
                  <Td>
                    <Badge>{p.status}</Badge>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </main>
  );
}

function ModeBanner({ config }: { config: Config }) {
  const live = config.autopilot_enabled && !config.shadow_mode;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="font-medium">
          {live ? '🟢 Autopilot aktywny' : '🟡 Tryb próbny'}
        </span>
        <span className="text-muted">
          shadow_mode: <strong>{String(config.shadow_mode)}</strong>
        </span>
        <span className="text-muted">
          próg score: <strong>{config.min_score}</strong>
        </span>
        <span className="text-muted">
          limit dzienny: <strong>{config.max_posts_per_day}</strong>
        </span>
      </div>
      {!live && (
        <p className="mt-2 text-xs text-muted">
          System renderuje i kolejkuje, ale nie publikuje. Wyłącz{' '}
          <code>shadow_mode</code> i włącz <code>autopilot_enabled</code> w tabeli{' '}
          <code>config</code>, gdy scoring się sprawdzi na danych.
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Table({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            {headers.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border bg-card px-1.5 py-0.5 text-xs text-muted">
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pl', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
