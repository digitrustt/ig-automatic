import { z } from 'zod';
import { errorMessage } from '@/lib/errors';
import type { Post } from '@/lib/types/db';
import { anthropicProvider } from './providers/anthropic';
import { ollamaProvider } from './providers/ollama';
import { openAICompatibleProvider } from './providers/openai-compatible';
import { templateProvider } from './providers/template';
import type { Copy, CopyProvider, PromptParts } from './providers/types';

export type { Copy };

export const CopySchema = z.object({
  hook: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

const PROVIDERS: Record<string, CopyProvider> = {
  cloud: openAICompatibleProvider,
  ollama: ollamaProvider,
  anthropic: anthropicProvider,
  template: templateProvider,
};

function selectedProvider(): CopyProvider {
  const name = process.env.COPY_PROVIDER || 'cloud';
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unknown COPY_PROVIDER "${name}" (expected: ${Object.keys(PROVIDERS).join(', ')})`,
    );
  }
  return provider;
}

const SYSTEM = `You write short-form video copy for an Instagram Reels account.

Your job is to produce the account's own editorial layer over a clip that was
discovered elsewhere. The hook and caption must stand on their own as this
account's voice — never restate or copy the original creator's caption, and
never present the clip as something the account filmed itself.

How a hook earns its place:
- It creates a specific open loop the video closes. "You won't believe this" is
  not a hook; "he waited 4 years for this shot" is.
- It reads in one glance at arm's length. Short words, no clauses.
- It matches what actually happens in the clip. A hook the video does not pay
  off costs more retention than a weak hook.

The caption is not a summary of the video — the viewer just watched it. Use it
to add the one piece of context the clip lacks, then invite a reply.

Hashtags are for reach, not decoration: a few broad tags the niche actually
searches, the rest specific enough that the post can rank in them.

Only use hashtags that already exist and are in common use. A tag you invented
reaches nobody, and an invented word in the target language reads as a mistake
to every native speaker who sees it. When in doubt, give fewer tags, or reuse
the ones already on the source post. Never coin a new word.

Reply with JSON only.`;

/**
 * Stated explicitly rather than inferred from the source caption. Models given
 * an English system prompt answer in English regardless of what the source
 * material is written in, which quietly produces English copy for a Polish
 * account — correct-looking output that is useless in the feed.
 */
function languageInstruction(language: string): string {
  return `Write the hook, the caption and the hashtags in ${language}. This applies even though these instructions are in English.`;
}

export interface CopyInput {
  post: Pick<Post, 'niche' | 'caption' | 'author_handle' | 'duration_seconds'>;
  /** The account we are publishing to, e.g. "@yourpage". */
  brandHandle: string;
  /** Hooks used recently, so the generator does not repeat itself. */
  recentHooks?: string[];
  /** Output language, e.g. "Polish". Defaults to COPY_LANGUAGE. */
  language?: string;
}

/**
 * Generates the account's own hook, caption and tags for a clip.
 *
 * Falls back to the template provider if the configured one fails: a weaker
 * hook still ships, whereas a dead Ollama would otherwise stall every render
 * in the queue behind it.
 */
export async function generateCopy(input: CopyInput): Promise<Copy> {
  const parts = buildPrompt(input);
  const provider = selectedProvider();

  try {
    return normalize(CopySchema.parse(await provider.generate(parts)));
  } catch (err) {
    if (provider.name === 'template') throw err;

    console.warn(
      JSON.stringify({
        level: 'warn',
        message: `copy provider ${provider.name} failed, using template`,
        error: errorMessage(err),
      }),
    );
    return normalize(CopySchema.parse(await templateProvider.generate(parts)));
  }
}

function buildPrompt(input: CopyInput): PromptParts {
  const { post, brandHandle, recentHooks = [] } = input;
  const language = input.language || process.env.COPY_LANGUAGE || 'Polish';

  const context = [
    // First line, because models weight the head of the message most heavily.
    languageInstruction(language),
    `Account: ${brandHandle}`,
    `Niche: ${post.niche}`,
    post.duration_seconds ? `Clip length: ${Math.round(post.duration_seconds)}s` : null,
    post.caption ? `Original caption (context only, do not reuse):\n${post.caption}` : null,
    recentHooks.length
      ? `Hooks this account used recently — write something different:\n${recentHooks
          .map((h) => `- ${h}`)
          .join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system: SYSTEM, context, post, brandHandle };
}

/** Trims the model's output to what the platform and the video frame allow. */
function normalize(copy: Copy): Copy {
  return {
    hook: copy.hook.trim().slice(0, 70),
    caption: copy.caption.trim().slice(0, 2100),
    hashtags: copy.hashtags
      .map((h) => h.replace(/^#/, '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12),
  };
}
