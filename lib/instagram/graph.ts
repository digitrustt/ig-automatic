const BASE = 'https://graph.facebook.com';

function version(): string {
  return process.env.IG_GRAPH_VERSION || 'v21.0';
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** Rate limits and transient server errors are worth another attempt. */
  get retryable(): boolean {
    if (this.status >= 500) return true;
    return this.code === 4 || this.code === 17 || this.code === 32 || this.code === 613;
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
  };
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE}/${version()}${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  if (method === 'GET') {
    body.forEach((v, k) => url.searchParams.set(k, v));
  }

  const res = await fetch(url, {
    method,
    body: method === 'POST' ? body : undefined,
    headers:
      method === 'POST'
        ? { 'content-type': 'application/x-www-form-urlencoded' }
        : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new GraphError(`Non-JSON response: ${text.slice(0, 300)}`, res.status);
  }

  if (!res.ok) {
    const e = (parsed as GraphErrorBody).error;
    throw new GraphError(
      e?.message ?? `Graph API ${res.status}`,
      res.status,
      e?.code,
      e?.error_subcode,
    );
  }

  return parsed as T;
}

export function graphGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  return request<T>('GET', path, token, params);
}

export function graphPost<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  return request<T>('POST', path, token, params);
}
