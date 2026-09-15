/**
 * PDF, via pdf.js (through `unpdf`, which ships it without the browser assumptions).
 *
 * Two outcomes matter more than the happy path. A scanned PDF has no text layer at all
 * and must come back as "no text found" rather than as an empty document that looks
 * successfully processed; and a password-protected PDF must come back as such rather
 * than as corrupt, because the person can act on the first and not on the second.
 */

import { corrupt, noTextFound } from '../errors.js';
import {
  capCharacters,
  extensionOf,
  normaliseMimeType,
  tidyText,
  type ExtractedDocument,
  type ExtractionRequest,
  type Extractor,
} from './types.js';

const PDF_MAGIC = '%PDF-';

/** Readable text per page below which a page is treated as an image of a page. */
const SCANNED_PAGE_CHAR_THRESHOLD = 12;

export class PdfExtractor implements Extractor {
  readonly name = 'pdf';

  supports(input: { mimeType: string; filename: string }): boolean {
    const mime = normaliseMimeType(input.mimeType);
    if (mime === 'application/pdf' || mime === 'application/x-pdf') return true;
    return extensionOf(input.filename) === 'pdf';
  }

  async extract(request: ExtractionRequest): Promise<ExtractedDocument> {
    const warnings: string[] = [];

    if (!startsWithPdfMagic(request.bytes)) {
      throw corrupt(request.filename, 'saknar PDF-signatur');
    }

    const pages = await readPages(request, warnings);
    const kept = pages.slice(0, request.limits.maxPages);
    if (pages.length > kept.length) {
      warnings.push(
        `Dokumentet har ${pages.length} sidor – bara de första ${request.limits.maxPages} har lästs in.`,
      );
    }

    const readable = kept.filter((page) => page.trim().length >= SCANNED_PAGE_CHAR_THRESHOLD);

    if (readable.length === 0) throw noTextFound(request.filename);
    if (readable.length < kept.length / 2) {
      warnings.push(
        'Stora delar av dokumentet ser ut att vara inskannade bilder och kunde inte läsas som text.',
      );
    }

    const text = capCharacters(tidyText(kept.join('\n\n')), request.limits, warnings);
    if (text.trim().length === 0) throw noTextFound(request.filename);

    return { text, pageCount: pages.length, warnings, extractor: this.name };
  }
}

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  // The signature is allowed a little junk in front of it; readers tolerate it, so a
  // strict check at offset zero would reject files every other tool opens.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes(PDF_MAGIC);
}

async function readPages(request: ExtractionRequest, warnings: string[]): Promise<string[]> {
  // pdf.js takes ownership of the buffer it is handed and detaches it. These same bytes
  // are on their way to the blob store, so it gets a copy and never the original.
  const copy = new Uint8Array(request.bytes.byteLength);
  copy.set(request.bytes);

  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(copy);
    const { text } = await extractText(pdf, { mergePages: false });
    return Array.isArray(text) ? text : [text];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/password/i.test(message)) {
      throw corrupt(request.filename, 'lösenordsskyddad');
    }
    // pdf.js reports a truncated or malformed xref table this way, which is by far the
    // most common way a real PDF arrives broken.
    if (/invalid|xref|structure|corrupt/i.test(message)) {
      throw corrupt(request.filename, 'PDF-strukturen kunde inte läsas');
    }

    warnings.push('PDF-läsaren rapporterade ett fel; texten kan vara ofullständig.');
    throw corrupt(request.filename, message.slice(0, 120));
  }
}
