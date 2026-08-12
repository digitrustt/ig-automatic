import { GraphError, graphGet, graphPost } from './graph';

export interface PublishInput {
  igUserId: string;
  accessToken: string;
  videoUrl: string;
  caption: string;
}

export interface PublishResult {
  mediaId: string;
  permalink: string | null;
}

interface ContainerResponse {
  id: string;
}

interface ContainerStatus {
  status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

/** Instagram transcodes before it will publish; this is the wait budget. */
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 6_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes a Reel through the two-step container flow: create a container,
 * wait for Instagram to finish pulling and transcoding the file, then publish.
 * Publishing before the container is FINISHED fails, so the poll is required.
 */
export async function publishReel(input: PublishInput): Promise<PublishResult> {
  const { igUserId, accessToken, videoUrl, caption } = input;

  const container = await graphPost<ContainerResponse>(
    `/${igUserId}/media`,
    accessToken,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: 'true',
    },
  );

  await waitForContainer(container.id, accessToken);

  const published = await graphPost<ContainerResponse>(
    `/${igUserId}/media_publish`,
    accessToken,
    { creation_id: container.id },
  );

  let permalink: string | null = null;
  try {
    const media = await graphGet<{ permalink?: string }>(
      `/${published.id}`,
      accessToken,
      { fields: 'permalink' },
    );
    permalink = media.permalink ?? null;
  } catch {
    // The post is live either way; a missing permalink is cosmetic.
  }

  return { mediaId: published.id, permalink };
}

async function waitForContainer(
  containerId: string,
  accessToken: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const status = await graphGet<ContainerStatus>(`/${containerId}`, accessToken, {
      fields: 'status_code,status',
    });

    switch (status.status_code) {
      case 'FINISHED':
        return;
      case 'ERROR':
        throw new Error(`Container failed: ${status.status ?? 'unknown error'}`);
      case 'EXPIRED':
        throw new Error('Container expired before it was published');
      default:
        continue;
    }
  }

  throw new Error(
    `Container still processing after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
  );
}

export interface InsightMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
}

interface InsightsResponse {
  data: Array<{ name: string; values?: Array<{ value: number }> }>;
}

/** Pulls the insight metrics for one of our own published Reels. */
export async function fetchReelInsights(
  mediaId: string,
  accessToken: string,
): Promise<InsightMetrics> {
  const empty: InsightMetrics = {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    follows: null,
  };

  try {
    const res = await graphGet<InsightsResponse>(
      `/${mediaId}/insights`,
      accessToken,
      { metric: 'views,likes,comments,shares,saved,total_interactions' },
    );

    const byName = new Map(
      res.data.map((m) => [m.name, m.values?.[0]?.value ?? null]),
    );

    return {
      views: byName.get('views') ?? null,
      likes: byName.get('likes') ?? null,
      comments: byName.get('comments') ?? null,
      shares: byName.get('shares') ?? null,
      saves: byName.get('saved') ?? null,
      follows: null, // per-media follow attribution is not exposed
    };
  } catch (err) {
    // Insights lag publication by a few minutes and 400 until they exist.
    if (err instanceof GraphError && err.status === 400) return empty;
    throw err;
  }
}
