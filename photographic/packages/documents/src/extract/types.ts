/**
 * One interface per file type, all behind `Extractor`.
 *
 * Every limit here is explicit. A document arrives from the internet, sometimes as a
 * zip archive pretending to be a Word file, and "read it all into a string" is how a
 * 42 kB upload turns into 4 GB of resident memory.
 */

export interface ExtractionLimits {
  /** Refuse input larger than this outright. */
  maxBytes: number;
  /** Pages beyond this are skipped with a warning rather than failing the document. */
  maxPages: number;
  /** Hard ceiling on extracted characters; the tail is dropped with a warning. */
  maxCharacters: number;
  /**
   * Decompressed bytes per stored byte. Real prose in a .docx lands around 5–20x;
   * a zip bomb is four or more orders of magnitude above that.
   */
  maxExpansionRatio: number;
  /** Refuse an archive declaring more entries than this. */
  maxArchiveEntries: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxPages: 1500,
  maxCharacters: 4_000_000,
  maxExpansionRatio: 250,
  maxArchiveEntries: 2048,
};

export interface ExtractionRequest {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  limits: ExtractionLimits;
}

export interface ExtractedDocument {
  /** Plain text, with markdown headings where the source had structure. */
  text: string;
  pageCount: number | null;
  /** Swedish, shown to the uploader: truncation and skipped pages are their business. */
  warnings: string[];
  extractor: string;
}

export interface Extractor {
  readonly name: string;
  supports(input: { mimeType: string; filename: string }): boolean;
  extract(request: ExtractionRequest): Promise<ExtractedDocument>;
}

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/** Strips parameters and case from a Content-Type. */
export function normaliseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Applies the character ceiling, appending a Swedish warning when it bites. */
export function capCharacters(
  text: string,
  limits: ExtractionLimits,
  warnings: string[],
): string {
  if (text.length <= limits.maxCharacters) return text;
  warnings.push(
    `Dokumentet är ovanligt stort – bara de första ${Math.round(
      limits.maxCharacters / 1000,
    )} 000 tecknen har lästs in.`,
  );
  return text.slice(0, limits.maxCharacters);
}

/** Normalises whitespace without destroying paragraph structure. */
export function tidyText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\f/g, '\n\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
