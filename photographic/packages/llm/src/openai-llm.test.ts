/**
 * OpenAiLlm against a stub client — no network, asserts request shape and LlmPort behaviour.
 */

import { describe, expect, it, vi } from 'vitest';

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, OpenAiLlm, type OpenAiClientLike } from './openai-llm.js';

function stubClient(overrides?: Partial<{
  embedding: number[];
  chatContent: string;
}>): OpenAiClientLike {
  const embedding =
    overrides?.embedding ?? Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string[] }) => ({
        data: input.map((_, index) => ({ index, embedding: [...embedding] })),
      })),
    },
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: overrides?.chatContent ?? '{"facts":[]}' } }],
        })),
      },
    },
  };
}

describe('OpenAiLlm', () => {
  it('embeds in order and pins model + dimensions', async () => {
    const client = stubClient();
    const llm = new OpenAiLlm({ client });
    const vectors = await llm.embed(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(client.embeddings.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: EMBEDDING_MODEL,
        input: ['a', 'b'],
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    );
  });

  it('refuses empty embed texts', async () => {
    const llm = new OpenAiLlm({ client: stubClient() });
    await expect(llm.embed(['ok', '  '])).rejects.toThrow(/empty text/);
  });

  it('summarises via chat completions', async () => {
    const client = stubClient({ chatContent: 'Kort brief.' });
    const llm = new OpenAiLlm({ client });
    const out = await llm.summarise({ texts: ['Ett faktum.'], budgetTokens: 40, as: 'briefing' });
    expect(out).toBe('Kort brief.');
    expect(client.chat.completions.create).toHaveBeenCalled();
  });

  it('short-circuits compare on exact duplicates', async () => {
    const client = stubClient();
    const llm = new OpenAiLlm({ client });
    await expect(llm.compare('Allergisk mot ketchup.', 'allergisk mot ketchup')).resolves.toBe(
      'same',
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });
});
