/**
 * The real `LlmPort` against OpenAI.
 *
 * Constructed with a client rather than an API key, so nothing in this file reads
 * `process.env` and importing it without a key is always safe. `createLlm` in
 * `select.ts` owns the key and decides which provider exists at all.
 */

import type { ItemKind, LlmPort } from '@photographic/core';
import { dedupeHash } from '@photographic/core';
import type { CompareVerdict, JsonSchemaObject } from './prompts.js';
import {
  buildCompareUserMessage,
  buildExtractUserMessage,
  buildSummariseUserMessage,
  clampToBudget,
  COMPARE_SCHEMA,
  COMPARE_SCHEMA_NAME,
  PLACEMENT_SCHEMA,
  PLACEMENT_SCHEMA_NAME,
  PLACEMENT_SYSTEM_PROMPT,
  buildPlacementUserMessage,
  parsePlacement,
  COMPARE_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  FACTS_SCHEMA,
  FACTS_SCHEMA_NAME,
  LlmResponseError,
  parseCompare,
  parseFacts,
  parseJsonObject,
  HEADLINE_SYSTEM_PROMPT,
  SUMMARISE_SYSTEM_PROMPT,
} from './prompts.js';

/**
 * 1536 is not a tuning knob: `item_embedding.embedding` and `chunk.embedding` are
 * `vector(1536)` in the frozen schema. Changing the model or the dimension count is a
 * migration plus a re-embed job, never a config tweak.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/** Cheap and fast enough to sit in a voice write path. */
export const EXTRACT_MODEL = 'gpt-4o-mini';

/**
 * Inputs per embedding request. The API accepts far more, but a single request is also
 * capped in tokens, and a smaller batch means a retry re-sends less work.
 */
export const MAX_EMBED_BATCH = 128;

/**
 * Sent on every completion request: do not keep this.
 *
 * What this does and does not buy, stated precisely, because the difference is what a
 * customer would be told:
 *
 *  - It opts the request out of OpenAI's own storage of the exchange — the thing that
 *    otherwise makes prompts and completions retrievable from the platform afterwards.
 *  - It does **not** make retention zero. OpenAI keeps API traffic for up to 30 days for
 *    abuse monitoring regardless, and zero-data-retention is arranged with OpenAI as an
 *    organisation-level agreement rather than granted by a key or a request flag.
 *  - Training is separate again and is already the default: API data is not trained on
 *    unless an organisation opts in, which this one has not.
 *
 * The embeddings endpoint takes no equivalent parameter, so what controls exposure there
 * is what we send rather than what we ask them not to keep — see the note in
 * `STATUS.md` on exactly which text leaves the server and when.
 *
 * No `user` field is ever sent either. It is meant for abuse-tracing and would attach a
 * person id of ours to text on somebody else's infrastructure, which is a correlation we
 * are not obliged to hand over and cannot take back.
 */
const NO_STORE = false;

export interface OpenAiEmbeddingRequest {
  model: string;
  input: string[];
  dimensions?: number;
  encoding_format?: 'float';
}

export interface OpenAiEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

export interface OpenAiChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  /**
   * `false` on every request this class makes. See `NO_STORE`.
   */
  store?: boolean;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: true; schema: JsonSchemaObject };
  };
}

export interface OpenAiChatResponse {
  choices: Array<{ message: { content: string | null } }>;
}

/**
 * The slice of the `openai` client this package uses. The real `OpenAI` instance
 * satisfies it; tests pass a stub and assert on the request shape.
 */
export interface OpenAiClientLike {
  embeddings: {
    create(body: OpenAiEmbeddingRequest): Promise<OpenAiEmbeddingResponse>;
  };
  chat: {
    completions: {
      create(body: OpenAiChatRequest): Promise<OpenAiChatResponse>;
    };
  };
}

export interface OpenAiLlmOptions {
  client: OpenAiClientLike;
  embeddingModel?: string;
  chatModel?: string;
  dimensions?: number;
  maxBatchSize?: number;
}

export class OpenAiLlm implements LlmPort {
  private readonly client: OpenAiClientLike;
  private readonly embeddingModel: string;
  private readonly chatModel: string;
  private readonly dimensions: number;
  private readonly maxBatchSize: number;

  constructor(options: OpenAiLlmOptions) {
    this.client = options.client;
    this.embeddingModel = options.embeddingModel ?? EMBEDDING_MODEL;
    this.chatModel = options.chatModel ?? EXTRACT_MODEL;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? MAX_EMBED_BATCH);
  }

  /**
   * What gets written next to every vector this class produces.
   *
   * `external: true` is the load-bearing part: it is how a memory can answer that its
   * own text was sent to a third party at write time, which is a promise made to the
   * person rather than an implementation note.
   */
  embeddingIdentity(): { provider: string; model: string; external: boolean } {
    return { provider: 'openai', model: this.embeddingModel, external: true };
  }

  /**
   * Order in equals order out. Callers zip the result against their own array of items,
   * so a reordered response would attach the wrong vector to the wrong memory.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const blank = texts.findIndex((t) => t.trim() === '');
    if (blank !== -1) {
      throw new LlmResponseError(`cannot embed empty text at index ${blank}`, 'openai');
    }

    const out: number[][] = new Array(texts.length);

    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      const batch = texts.slice(offset, offset + this.maxBatchSize);
      const response = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: batch,
        dimensions: this.dimensions,
        encoding_format: 'float',
      });

      const data = response.data ?? [];
      if (data.length !== batch.length) {
        throw new LlmResponseError(
          `embedding count mismatch: sent ${batch.length}, received ${data.length}`,
          'openai',
        );
      }

      for (const row of data) {
        if (row.index < 0 || row.index >= batch.length) {
          throw new LlmResponseError(`embedding index ${row.index} outside batch`, 'openai');
        }
        if (row.embedding.length !== this.dimensions) {
          throw new LlmResponseError(
            `embedding has ${row.embedding.length} dimensions, expected ${this.dimensions}`,
            'openai',
          );
        }
        out[offset + row.index] = row.embedding;
      }
    }

    return out;
  }

  async extractFacts(input: {
    text: string;
    existing: string[];
  }): Promise<Array<{ body: string; kind: ItemKind; confidence: number }>> {
    if (input.text.trim() === '') return [];

    const raw = await this.json({
      system: EXTRACT_SYSTEM_PROMPT,
      user: buildExtractUserMessage(input),
      schemaName: FACTS_SCHEMA_NAME,
      schema: FACTS_SCHEMA,
    });

    return parseFacts(raw, input.existing);
  }

  async compare(a: string, b: string): Promise<CompareVerdict> {
    // Exact duplicates after normalisation need no model call, and ChatGPT and Claude
    // both independently try to save the same sentence, so this path is hot.
    if (dedupeHash(a) === dedupeHash(b)) return 'same';

    const raw = await this.json({
      system: COMPARE_SYSTEM_PROMPT,
      user: buildCompareUserMessage(a, b),
      schemaName: COMPARE_SCHEMA_NAME,
      schema: COMPARE_SCHEMA,
    });

    return parseCompare(raw);
  }

  /**
   * Confirms or rejects a shortlisted room. It cannot choose one — see `RoutingDeps`.
   *
   * Every failure path lands on `belongs: false`, which keeps the memory private. That is
   * the one direction where being wrong costs nothing that cannot be undone in a click.
   */
  async confirmPlacement(input: {
    text: string;
    roomTitle: string;
    roomHeadline: string;
  }): Promise<{ belongs: boolean; because?: string }> {
    try {
      const raw = await this.json({
        system: PLACEMENT_SYSTEM_PROMPT,
        user: buildPlacementUserMessage(input),
        schemaName: PLACEMENT_SCHEMA_NAME,
        schema: PLACEMENT_SCHEMA,
      });
      return parsePlacement(raw);
    } catch {
      return { belongs: false };
    }
  }

  async summarise(input: {
    texts: string[];
    budgetTokens: number;
    as?: 'briefing' | 'headline';
  }): Promise<string> {
    const texts = input.texts.map((t) => t.trim()).filter(Boolean);
    if (texts.length === 0 || input.budgetTokens <= 0) return '';

    const response = await this.client.chat.completions.create({
      model: this.chatModel,
      temperature: 0,
      store: NO_STORE,
      max_tokens: Math.max(64, Math.ceil(input.budgetTokens * 1.1)),
      messages: [
        {
          role: 'system',
          content: input.as === 'headline' ? HEADLINE_SYSTEM_PROMPT : SUMMARISE_SYSTEM_PROMPT,
        },
        { role: 'user', content: buildSummariseUserMessage({ ...input, texts }) },
      ],
    });

    const content = response.choices[0]?.message.content ?? '';
    return clampToBudget(content, input.budgetTokens);
  }

  private async json(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: JsonSchemaObject;
  }): Promise<unknown> {
    const response = await this.client.chat.completions.create({
      model: this.chatModel,
      temperature: 0,
      store: NO_STORE,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: input.schemaName, strict: true, schema: input.schema },
      },
    });

    return parseJsonObject(response.choices[0]?.message.content, 'openai');
  }
}
