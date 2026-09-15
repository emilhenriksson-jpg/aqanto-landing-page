/**
 * Chooses which `LlmPort` the process runs.
 *
 * Default is `FakeLlm` so `pnpm test` and a laptop without a key stay deterministic.
 * `PHOTOGRAPHIC_LLM=openai` plus `OPENAI_API_KEY` flips to the real client — the only
 * place in this package that reads the environment.
 */

import type { LlmPort } from '@photographic/core';
import { FakeLlm } from '@photographic/core/testing';
import OpenAI from 'openai';

import { OpenAiLlm } from './openai-llm.js';

export type LlmSelection =
  | { kind: 'fake'; llm: LlmPort }
  | { kind: 'openai'; llm: LlmPort };

export function createLlmFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmSelection {
  const provider = (env.PHOTOGRAPHIC_LLM ?? env.LLM_PROVIDER ?? 'fake').toLowerCase();

  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'PHOTOGRAPHIC_LLM=openai requires OPENAI_API_KEY. Unset PHOTOGRAPHIC_LLM to keep FakeLlm.',
      );
    }
    const client = new OpenAI({ apiKey });
    // The SDK's generated request types are wider than the slice we type; the runtime
    // shape matches. Casting here keeps OpenAiLlm free of `process.env` and of the
    // full SDK surface.
    return { kind: 'openai', llm: new OpenAiLlm({ client: client as never }) };
  }

  if (provider !== 'fake' && provider !== '') {
    throw new Error(
      `Unknown PHOTOGRAPHIC_LLM="${provider}". Supported: fake, openai.`,
    );
  }

  return { kind: 'fake', llm: new FakeLlm() };
}
