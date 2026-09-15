/**
 * Which extractor reads which file, and the one entry point that runs it.
 *
 * Order matters. A `.docx` is a zip and a `.md` is text, so the specific extractors are
 * asked before the general one — `TextExtractor` claims anything `text/*` and would
 * otherwise happily decode a PDF into line noise.
 *
 * `extractText` never throws for an unreadable file. Extraction failing is a normal
 * outcome of accepting documents from the internet, and the file is already stored by
 * the time this runs: the bytes are safe, so the caller gets a result describing what
 * happened rather than an exception it has to remember to catch.
 */

import { ExtractionError, tooLarge, unsupportedType } from '../errors.js';
import { DocxExtractor } from './docx.js';
import { HtmlExtractor } from './html.js';
import { PdfExtractor } from './pdf.js';
import { TextExtractor } from './text.js';
import {
  DEFAULT_EXTRACTION_LIMITS,
  type ExtractedDocument,
  type ExtractionLimits,
  type Extractor,
} from './types.js';

export * from './types.js';
export { ExtractionError } from '../errors.js';
export type { ExtractionFailureReason } from '../errors.js';
export { DocxExtractor } from './docx.js';
export { HtmlExtractor, htmlToText } from './html.js';
export { PdfExtractor } from './pdf.js';
export { TextExtractor, decodeText } from './text.js';
export { inspectArchive, NotAnArchiveError, type ArchiveSummary } from './zip.js';

export const DEFAULT_EXTRACTORS: readonly Extractor[] = Object.freeze([
  new PdfExtractor(),
  new DocxExtractor(),
  new HtmlExtractor(),
  new TextExtractor(),
]);

export function pickExtractor(
  input: { mimeType: string; filename: string },
  extractors: readonly Extractor[] = DEFAULT_EXTRACTORS,
): Extractor | null {
  return extractors.find((extractor) => extractor.supports(input)) ?? null;
}

/** Why a document has no text. Mirrors `app.extraction_status` minus `pending`. */
export type ExtractionOutcome = 'extracted' | 'unsupported' | 'empty' | 'failed';

export interface ExtractionResult {
  outcome: ExtractionOutcome;
  /** Empty unless `outcome` is `extracted`. */
  text: string;
  pageCount: number | null;
  warnings: string[];
  extractor: string | null;
  /** Swedish, shown to the uploader. Null when extraction succeeded. */
  error: string | null;
}

export interface ExtractOptions {
  limits?: ExtractionLimits;
  extractors?: readonly Extractor[];
}

export async function extractText(
  input: { bytes: Uint8Array; filename: string; mimeType: string },
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const limits = options.limits ?? DEFAULT_EXTRACTION_LIMITS;
  const extractors = options.extractors ?? DEFAULT_EXTRACTORS;

  if (input.bytes.byteLength > limits.maxBytes) {
    return failure(
      'failed',
      tooLarge(`Filen är större än ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`),
      null,
    );
  }

  const extractor = pickExtractor(input, extractors);
  if (!extractor) {
    return failure('unsupported', unsupportedType(input.filename, input.mimeType), null);
  }

  try {
    const extracted: ExtractedDocument = await extractor.extract({
      bytes: input.bytes,
      filename: input.filename,
      mimeType: input.mimeType,
      limits,
    });

    return {
      outcome: 'extracted',
      text: extracted.text,
      pageCount: extracted.pageCount,
      warnings: extracted.warnings,
      extractor: extracted.extractor,
      error: null,
    };
  } catch (error) {
    if (error instanceof ExtractionError) {
      return failure(outcomeFor(error), error, extractor.name);
    }
    // An extractor throwing something else is a bug in the extractor, not a verdict on
    // the file. Still not allowed to fail the upload: the bytes are already stored.
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'failed',
      text: '',
      pageCount: null,
      warnings: [],
      extractor: extractor.name,
      error: `Kunde inte läsa "${input.filename}". Filen är sparad. (${message.slice(0, 120)})`,
    };
  }
}

function outcomeFor(error: ExtractionError): ExtractionOutcome {
  switch (error.reason) {
    case 'unsupported':
      return 'unsupported';
    case 'empty':
      return 'empty';
    default:
      return 'failed';
  }
}

function failure(
  outcome: ExtractionOutcome,
  error: ExtractionError,
  extractor: string | null,
): ExtractionResult {
  return { outcome, text: '', pageCount: null, warnings: [], extractor, error: error.message };
}
