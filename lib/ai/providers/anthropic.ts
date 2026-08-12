import Anthropic from '@anthropic-ai/sdk';
import { COPY_SCHEMA, type Copy, type CopyProvider, type PromptParts } from './types';

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
}

/**
 * Paid path, opt-in via COPY_PROVIDER=anthropic. Noticeably better hooks than a
 * small local model, but it is the only metered component in the stack — the
 * default build runs entirely on Ollama.
 */
export const anthropicProvider: CopyProvider = {
  name: 'anthropic',

  async generate(parts: PromptParts): Promise<Copy> {
    const response = await client().messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      // Stable across every render job, so it is worth caching.
      system: [
        { type: 'text', text: parts.system, cache_control: { type: 'ephemeral' } },
      ],
      output_config: {
        // Short, well-specified generation — the cheap end of the ladder is enough.
        effort: 'low',
        format: { type: 'json_schema', schema: COPY_SCHEMA },
      },
      messages: [{ role: 'user', content: parts.context }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `Copy generation refused (${response.stop_details?.category ?? 'unknown'})`,
      );
    }

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
    }

    return JSON.parse(text.text) as Copy;
  },
};
