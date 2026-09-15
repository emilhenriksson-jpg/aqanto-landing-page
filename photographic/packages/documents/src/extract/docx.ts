/**
 * Word documents, via mammoth.
 *
 * Converted to HTML first and then through the HTML extractor rather than pulled out as
 * raw text. `extractRawText` flattens every heading into an ordinary paragraph, and the
 * chunker splits on headings — so the cheaper path costs exactly the structure that
 * makes a citation say which section it came from.
 *
 * A `.docx` is a zip archive, so the archive limits apply before mammoth sees it.
 * Decompression happens inside the library and cannot be bounded from out here, which
 * means the only place to refuse a zip bomb is before handing it over.
 */

import { corrupt, noTextFound, tooLarge } from '../errors.js';
import { htmlToText } from './html.js';
import {
  capCharacters,
  extensionOf,
  normaliseMimeType,
  type ExtractedDocument,
  type ExtractionRequest,
  type Extractor,
} from './types.js';
import { inspectArchive, NotAnArchiveError } from './zip.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class DocxExtractor implements Extractor {
  readonly name = 'docx';

  supports(input: { mimeType: string; filename: string }): boolean {
    const mime = normaliseMimeType(input.mimeType);
    if (mime === DOCX_MIME) return true;
    return extensionOf(input.filename) === 'docx';
  }

  async extract(request: ExtractionRequest): Promise<ExtractedDocument> {
    const warnings: string[] = [];
    assertArchiveWithinLimits(request);

    const html = await convertToHtml(request, warnings);
    const text = capCharacters(htmlToText(html), request.limits, warnings);
    if (text.trim().length === 0) throw noTextFound(request.filename);

    return { text, pageCount: null, warnings, extractor: this.name };
  }
}

/**
 * Refuses an archive whose own index says it decompresses to more than we will read.
 *
 * Exported so the check is testable without a Word file: the interesting inputs here
 * are hostile, not typical.
 */
export function assertArchiveWithinLimits(request: ExtractionRequest): void {
  let summary;
  try {
    summary = inspectArchive(request.bytes);
  } catch (error) {
    if (error instanceof NotAnArchiveError) {
      throw corrupt(request.filename, 'filen är inte ett läsbart Word-dokument');
    }
    throw error;
  }

  if (summary.entryCount > request.limits.maxArchiveEntries) {
    throw tooLarge(
      `Filen innehåller ${summary.entryCount} delar, fler än vi läser (${request.limits.maxArchiveEntries}).`,
    );
  }

  const ratio = summary.uncompressedBytes / Math.max(request.bytes.byteLength, 1);
  if (summary.zip64 || ratio > request.limits.maxExpansionRatio) {
    throw tooLarge('Filen packas upp till orimligt mycket mer än sin egen storlek.');
  }

  if (summary.uncompressedBytes > request.limits.maxBytes) {
    throw tooLarge('Filen packas upp till mer än vi kan läsa.');
  }
}

async function convertToHtml(request: ExtractionRequest, warnings: string[]): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const convert = mammoth.convertToHtml ?? mammoth.default?.convertToHtml;
    if (!convert) throw new Error('mammoth exposed no convertToHtml');

    const result = await convert({ buffer: Buffer.from(request.bytes) });

    // mammoth reports unconvertible constructs rather than failing on them. Worth
    // surfacing once: a document that is mostly embedded objects extracts to very
    // little text, and the person should know that is why rather than assume we failed.
    if (result.messages.length > 12) {
      warnings.push('Delar av dokumentet (bilder, inbäddade objekt) kunde inte läsas som text.');
    }

    return result.value;
  } catch (error) {
    if (error && typeof error === 'object' && 'reason' in (error as Record<string, unknown>)) {
      throw corrupt(request.filename, String((error as { reason: unknown }).reason).slice(0, 120));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw corrupt(request.filename, message.slice(0, 120));
  }
}
