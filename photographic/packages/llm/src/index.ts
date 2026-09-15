/**
 * Public surface of `@photographic/llm`.
 *
 * `createLlmFromEnv` is the only thing that reads `process.env`. The OpenAI class
 * itself takes a client, so importing it without a key is always safe.
 */

export {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EXTRACT_MODEL,
  MAX_EMBED_BATCH,
  OpenAiLlm,
  type OpenAiClientLike,
  type OpenAiLlmOptions,
} from './openai-llm.js';

export {
  LlmResponseError,
  type CompareVerdict,
} from './prompts.js';

export { createLlmFromEnv, type LlmSelection } from './select.js';
