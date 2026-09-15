/**
 * Splitting extracted text into the pieces search actually returns.
 *
 * Chunking happens at ingest even though only Postgres full-text search runs over the
 * result today. That is the whole point of doing it now: adding embeddings later then
 * means backfilling one column, whereas chunking later means re-reading every PDF
 * anyone ever uploaded — through whatever extractor exists by then, producing different
 * boundaries for old documents than for new ones.
 *
 * So a chunk carries `embedding: null` rather than not carrying an embedding. The shape
 * is final; only the column is empty.
 *
 * Two properties are worth the complexity here:
 *
 *   - Headings are kept, both as their own field and folded into the chunk text. The
 *     field is what lets a citation say which section it came from; folding it in is
 *     what lets full-text search match a query against the section title, which is
 *     often exactly how a person searches for a passage they half remember.
 *   - Chunks overlap. The sentence that answers a question is frequently the one
 *     straddling a boundary, and a chunk that begins mid-argument retrieves poorly.
 */

import { estimateTokens } from '@photographic/core';

/** Target chunk size. Small enough to be a precise citation, large enough to mean something. */
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;

/**
 * Sections longer than this are split further rather than kept whole.
 *
 * A markdown document with one heading and forty pages under it is common, and a
 * "section" is only a useful chunk boundary when the section is chunk-sized.
 */
const MAX_SECTION_CHARS = CHUNK_CHARS;

export interface DocumentChunk {
  ord: number;
  /** The chunk as stored and searched: heading line first, when there is one. */
  text: string;
  /** The heading this chunk sits under, or null at the top of a document. */
  heading: string | null;
  tokenEstimate: number;
  /**
   * Always null today. Present so that turning embeddings on is a backfill rather than
   * a change to every write path that produces a chunk.
   */
  embedding: number[] | null;
}

export interface ChunkOptions {
  size?: number;
  overlap?: number;
}

/**
 * Splits text into chunks, respecting markdown headings where the extractor found them.
 *
 * The extractors emit `#`-prefixed headings precisely so this can see them; text with
 * no headings falls through to plain paragraph-boundary splitting and behaves exactly
 * as it did before headings existed.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): DocumentChunk[] {
  const size = options.size ?? CHUNK_CHARS;
  const overlap = options.overlap ?? CHUNK_OVERLAP;

  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];

  const chunks: DocumentChunk[] = [];
  let ord = 0;

  for (const section of splitIntoSections(clean)) {
    const pieces =
      section.body.length <= MAX_SECTION_CHARS
        ? [section.body]
        : splitByCharacters(section.body, size, overlap);

    for (const piece of pieces) {
      const body = piece.trim();
      if (!body) continue;

      // The heading is repeated on every chunk of a long section, not just the first.
      // A chunk retrieved from page nine of "Uppsägning" is useless if the only way to
      // know it is about termination is to also retrieve page one.
      const withHeading = section.heading ? `${section.heading}\n\n${body}` : body;

      chunks.push({
        ord: ord++,
        text: withHeading,
        heading: section.heading,
        tokenEstimate: estimateTokens(withHeading),
        embedding: null,
      });
    }
  }

  return chunks;
}

interface Section {
  heading: string | null;
  body: string;
}

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];

  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const joined = body.join('\n').trim();
    if (joined) sections.push({ heading, body: joined });
    body = [];
  };

  for (const line of lines) {
    const match = HEADING_LINE.exec(line);
    if (!match) {
      body.push(line);
      continue;
    }

    flush();
    heading = match[2]!.trim();
  }
  flush();

  // A document whose headings carry no text under them (a table of contents, mostly)
  // would otherwise chunk to nothing at all.
  return sections.length > 0 ? sections : [{ heading: null, body: text }];
}

/**
 * The fallback split: paragraph boundary, then sentence boundary, then the hard cap.
 *
 * Exported because it is the part with an off-by-one in it, and because text with no
 * structure at all is the common case for pasted notes and OCR output.
 */
export function splitByCharacters(text: string, size: number, overlap: number): string[] {
  const clean = text.trim();
  if (clean.length <= size) return clean ? [clean] : [];

  // Clamped to half the chunk, which is also the most overlap that is ever useful. An
  // overlap at or above `size` does not hang — the cursor still advances — it produces
  // a near-duplicate chunk per character, which is worse: fifty thousand rows and a
  // search index full of the same sentence, with nothing to notice it by.
  const step = Math.max(size - Math.min(overlap, Math.floor(size / 2)), 1);

  const pieces: string[] = [];
  let cursor = 0;

  while (cursor < clean.length) {
    const end = Math.min(cursor + size, clean.length);
    let cut = end;

    if (end < clean.length) {
      const paragraph = clean.lastIndexOf('\n\n', end);
      const sentence = clean.lastIndexOf('. ', end);
      const candidate = Math.max(paragraph, sentence);
      // Only honour a boundary in the second half of the window. Cutting at the first
      // full stop after a long quotation produces a 40-character chunk.
      if (candidate > cursor + size / 2) cut = candidate + 1;
    }

    const piece = clean.slice(cursor, cut).trim();
    if (piece) pieces.push(piece);
    if (cut >= clean.length) break;

    // Always forward by at least one character, even when a boundary was found behind
    // the cursor: `cut - overlap` alone can move backwards and never terminate.
    cursor = Math.max(cut - (size - step), cursor + 1);
  }

  return pieces;
}

/**
 * The legacy flat chunker, kept as the shape the two `DocumentPort` implementations
 * were written against.
 *
 * Both now call `chunkDocument`; this remains because the tests that pinned chunk sizes
 * are worth keeping and because "split this string" is occasionally all a caller wants.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  return chunkDocument(text, { size, overlap }).map((chunk) => chunk.text);
}
