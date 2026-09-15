/**
 * Embeddings must be optional at runtime: a down or unconfigured embedder narrows
 * ranking to lexical-only rather than failing the write or the search. `FakeLlm`
 * never throws, so this exercises the guarantee with a stand-in that does, the same
 * shape `PgRetrieval`/`PgIngest` make on the Postgres path for the same reason.
 */
import type { LlmPort } from '@photographic/core';
import { FakeLlm } from '@photographic/core/testing';
import { describe, expect, it } from 'vitest';

import { createMemoryServices } from './index.js';

function throwingLlm(): LlmPort {
  const fake = new FakeLlm();
  return {
    embed: async () => {
      throw new Error('simulated embedder outage');
    },
    extractFacts: (input) => fake.extractFacts(input),
    compare: (a, b) => fake.compare(a, b),
    summarise: (input) => fake.summarise(input),
  };
}

describe('degrading gracefully with no working embedder', () => {
  it('still saves the memory when embedding fails', async () => {
    const wired = createMemoryServices({ llm: throwingLlm() });
    const { person, personalRoom } = await wired.services.identity.register({
      email: 'degrade@example.com',
      displayName: 'Test',
    });
    const actor = wired.actorFor(person.id, 'claude-desktop');

    const result = await wired.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Allergisk mot ketchup',
      explicit: true,
    });

    expect(result.outcome).toBe('auto');
  });

  it('still finds it by lexical match when search cannot embed the query', async () => {
    const wired = createMemoryServices({ llm: throwingLlm() });
    const { person, personalRoom } = await wired.services.identity.register({
      email: 'degrade2@example.com',
      displayName: 'Test',
    });
    const actor = wired.actorFor(person.id, 'claude-desktop');

    await wired.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Allergisk mot ketchup',
      explicit: true,
    });

    const hits = await wired.services.retrieval.search(actor, { query: 'ketchup' });
    expect(hits.some((h) => h.text.includes('ketchup'))).toBe(true);
  });

  it('updating a memory still succeeds when re-embedding fails', async () => {
    const wired = createMemoryServices({ llm: throwingLlm() });
    const { person, personalRoom } = await wired.services.identity.register({
      email: 'degrade3@example.com',
      displayName: 'Test',
    });
    const actor = wired.actorFor(person.id, 'claude-desktop');

    const result = await wired.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Bor i Stockholm',
      explicit: true,
    });
    if (result.outcome !== 'auto') throw new Error('expected an auto save');

    const updated = await wired.services.ingest.update(
      actor,
      result.item.shortId,
      personalRoom.id,
      'Bor i Göteborg',
    );

    expect(updated.body).toBe('Bor i Göteborg');
  });
});
