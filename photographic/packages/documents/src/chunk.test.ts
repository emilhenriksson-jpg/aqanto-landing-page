import { describe, expect, it } from 'vitest';

import { CHUNK_CHARS, chunkDocument, splitByCharacters } from './chunk.js';

describe('chunkDocument', () => {
  it('keeps a short document as one chunk', () => {
    const chunks = chunkDocument('Huset i Mallorca är bokat i juli.');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ord: 0, heading: null, embedding: null });
    expect(chunks[0]!.text).toBe('Huset i Mallorca är bokat i juli.');
  });

  it('leaves every embedding null so turning them on is a backfill', () => {
    // The whole reason chunking happens at ingest: the shape is final, only the column
    // is empty. If a chunk ever shipped without this field, adding embeddings later
    // would mean re-extracting every document through whatever parser exists by then.
    const chunks = chunkDocument('# Ett\n\nText.\n\n# Två\n\nMer text.');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.embedding === null)).toBe(true);
  });

  it('splits on headings and records which section each chunk came from', () => {
    const chunks = chunkDocument(
      ['# Avtal', '', 'Gäller från 1 januari.', '', '## Uppsägning', '', 'Tre månader.'].join('\n'),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.heading).toBe('Avtal');
    expect(chunks[1]!.heading).toBe('Uppsägning');
    expect(chunks[1]!.text).toContain('Tre månader.');
  });

  it('folds the heading into the text so full-text search can match on it', () => {
    // A person searching for "uppsägning" is often searching for the section title
    // rather than for any sentence inside it.
    const chunks = chunkDocument('## Uppsägning\n\nTre månader ömsesidigt.');

    expect(chunks[0]!.text.startsWith('Uppsägning')).toBe(true);
    expect(chunks[0]!.text).toContain('Tre månader');
  });

  it('repeats the heading on every chunk of a long section', () => {
    // A chunk retrieved from deep inside "Uppsägning" is useless if the only way to
    // know what it is about is to also retrieve the first chunk.
    const body = 'Villkoren gäller i tolv månader. '.repeat(200);
    const chunks = chunkDocument(`## Uppsägning\n\n${body}`);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.heading === 'Uppsägning')).toBe(true);
    expect(chunks.every((chunk) => chunk.text.startsWith('Uppsägning'))).toBe(true);
  });

  it('numbers chunks consecutively across sections', () => {
    const chunks = chunkDocument('# A\n\nEtt.\n\n# B\n\nTvå.\n\n# C\n\nTre.');

    expect(chunks.map((chunk) => chunk.ord)).toEqual([0, 1, 2]);
  });

  it('returns nothing for empty text', () => {
    expect(chunkDocument('   \n\n ')).toEqual([]);
  });

  it('falls back to paragraph splitting when there are no headings', () => {
    const chunks = chunkDocument('a'.repeat(3000));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading === null)).toBe(true);
  });

  it('estimates tokens per chunk', () => {
    const chunks = chunkDocument('Ett kort stycke text.');
    expect(chunks[0]!.tokenEstimate).toBeGreaterThan(0);
  });
});

describe('splitByCharacters', () => {
  it('overlaps consecutive pieces', () => {
    // The sentence answering a question is frequently the one straddling a boundary.
    const text = Array.from({ length: 80 }, (_, i) => `Mening nummer ${i}.`).join(' ');
    const pieces = splitByCharacters(text, 400, 100);

    expect(pieces.length).toBeGreaterThan(2);
    const tail = pieces[0]!.slice(-40);
    expect(pieces[1]!.includes(tail.split(' ').at(-2) ?? '')).toBe(true);
  });

  it('prefers a paragraph boundary over the hard cap', () => {
    const text = `${'a'.repeat(900)}\n\n${'b'.repeat(900)}`;
    const pieces = splitByCharacters(text, 1000, 100);

    expect(pieces[0]).toBe('a'.repeat(900));
  });

  it('clamps an overlap wider than the chunk instead of emitting one chunk per character', () => {
    // Not an infinite loop — the cursor does advance — but 5000 near-identical chunks
    // is worse than a hang, because nothing fails and the search index quietly fills
    // with the same sentence.
    const pieces = splitByCharacters('x'.repeat(5000), 100, 500);

    expect(pieces.length).toBeLessThan(120);
    expect(pieces.length).toBeGreaterThan(50);
  });

  it('does not cut mid-window for text shorter than the size', () => {
    expect(splitByCharacters('kort', CHUNK_CHARS, 150)).toEqual(['kort']);
  });
});
