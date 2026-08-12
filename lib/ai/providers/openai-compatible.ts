import { COPY_SCHEMA, type Copy, type CopyProvider, type PromptParts } from './types';

/**
 * Free hosted inference through the OpenAI-compatible chat API.
 *
 * Groq, Cerebras and OpenRouter all speak this wire format and all publish a
 * free tier that is orders of magnitude larger than three posts a day needs,
 * so one adapter covers every option — switch host and model with env vars
 * instead of a code change.
 *
 * JSON is requested in `json_object` mode rather than strict schema mode: not
 * every free host implements schema-constrained decoding, and the caller
 * validates with zod and falls back to templates anyway.
 */
export const openAICompatibleProvider: CopyProvider = {
  name: 'cloud',

  async generate(parts: PromptParts): Promise<Copy> {
    const baseUrl = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
    const model = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
    const apiKey = process.env.LLM_API_KEY;

    if (!apiKey) throw new Error('LLM_API_KEY is not set');

    const schemaHint = `Reply with a single JSON object matching this schema:\n${JSON.stringify(
      COPY_SCHEMA,
      null,
      2,
    )}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${parts.system}\n\n${schemaHint}` },
          { role: 'user', content: parts.context },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned no message content');

    return JSON.parse(content) as Copy;
  },
};
