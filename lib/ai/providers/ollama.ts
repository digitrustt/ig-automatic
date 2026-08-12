import { COPY_SCHEMA, type Copy, type CopyProvider, type PromptParts } from './types';

/**
 * Local model over Ollama's HTTP API. Free and unmetered — it runs on the same
 * machine as the worker, so there is no per-call cost and no rate limit beyond
 * the box's own throughput.
 */
export const ollamaProvider: CopyProvider = {
  name: 'ollama',

  async generate(parts: PromptParts): Promise<Copy> {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL || 'phi3';

    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // Ollama constrains decoding to the schema, so the reply parses.
        format: COPY_SCHEMA,
        options: { temperature: 0.8 },
        messages: [
          { role: 'system', content: parts.system },
          { role: 'user', content: parts.context },
        ],
      }),
      // A cold model load on a small box can take a while.
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as { message?: { content?: string } };
    const content = payload.message?.content;
    if (!content) throw new Error('Ollama returned no message content');

    return JSON.parse(content) as Copy;
  },
};
