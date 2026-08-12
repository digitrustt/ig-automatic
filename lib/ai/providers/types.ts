import type { Post } from '@/lib/types/db';

export interface Copy {
  hook: string;
  caption: string;
  hashtags: string[];
}

export interface PromptParts {
  /** Role and craft instructions — stable across every job. */
  system: string;
  /** The per-clip context block. */
  context: string;
  /** Raw inputs, for providers that build copy without an LLM. */
  post: Pick<Post, 'niche' | 'caption' | 'author_handle' | 'duration_seconds'>;
  brandHandle: string;
}

/** JSON Schema every provider constrains its output to. */
export const COPY_SCHEMA = {
  type: 'object',
  properties: {
    hook: {
      type: 'string',
      description:
        'Scroll-stopping on-screen text for the first 2.5 seconds. Under 60 characters, no hashtags, no emoji.',
    },
    caption: {
      type: 'string',
      description:
        'Instagram caption in the account voice. Two or three short lines, ends with a question or a call to comment.',
    },
    hashtags: {
      type: 'array',
      description: 'Between 5 and 12 hashtags, no leading #, lowercase.',
      items: { type: 'string' },
    },
  },
  required: ['hook', 'caption', 'hashtags'],
  additionalProperties: false,
} as const;

export interface CopyProvider {
  name: string;
  generate(parts: PromptParts): Promise<Copy>;
}
