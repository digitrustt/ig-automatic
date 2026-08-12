/**
 * Supabase and the Graph API reject with plain objects rather than Error
 * instances, so `String(err)` yields "[object Object]" and the real cause is
 * lost. Every catch path in the pipeline goes through here instead.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;

  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof e.message === 'string') {
      const parts = [e.message];
      if (e.code) parts.push(`(code ${String(e.code)})`);
      // Supabase often repeats the message verbatim at the head of `details`.
      if (typeof e.details === 'string' && e.details && !e.details.startsWith(e.message)) {
        parts.push(e.details);
      }
      if (typeof e.hint === 'string' && e.hint) parts.push(`hint: ${e.hint}`);
      return parts.join(' ');
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }

  return String(err);
}
