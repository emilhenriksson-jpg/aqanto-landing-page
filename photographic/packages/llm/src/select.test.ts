/**
 * Env → LlmPort selection. Default must stay FakeLlm so the suite never needs a key.
 */

import { FakeLlm } from '@photographic/core/testing';
import { describe, expect, it } from 'vitest';

import { OpenAiLlm } from './openai-llm.js';
import { createLlmFromEnv } from './select.js';

describe('createLlmFromEnv', () => {
  it('defaults to FakeLlm when unset', () => {
    const selected = createLlmFromEnv({});
    expect(selected.kind).toBe('fake');
    expect(selected.llm).toBeInstanceOf(FakeLlm);
  });

  it('treats PHOTOGRAPHIC_LLM=fake as FakeLlm', () => {
    const selected = createLlmFromEnv({ PHOTOGRAPHIC_LLM: 'fake' });
    expect(selected.kind).toBe('fake');
    expect(selected.llm).toBeInstanceOf(FakeLlm);
  });

  it('requires OPENAI_API_KEY when PHOTOGRAPHIC_LLM=openai', () => {
    expect(() => createLlmFromEnv({ PHOTOGRAPHIC_LLM: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });

  it('selects OpenAiLlm when flag and key are set', () => {
    const selected = createLlmFromEnv({
      PHOTOGRAPHIC_LLM: 'openai',
      OPENAI_API_KEY: 'sk-test-not-a-real-key',
    });
    expect(selected.kind).toBe('openai');
    expect(selected.llm).toBeInstanceOf(OpenAiLlm);
  });

  it('rejects unknown providers', () => {
    expect(() => createLlmFromEnv({ PHOTOGRAPHIC_LLM: 'anthropic' })).toThrow(/Unknown/);
  });
});
