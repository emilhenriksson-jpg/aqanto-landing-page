/**
 * Plain text, markdown, CSV and JSON.
 *
 * The one extractor that has to guess at encoding. Everything else arrives in a
 * container that states its own: a `.txt` file arrives as bytes and a mojibake
 * "Ã¶" where an "ö" belongs is both unsearchable and unreadable, so it is worth
 * a little effort rather than assuming UTF-8 and moving on.
 */

import { noTextFound } from '../errors.js';
import {
  capCharacters,
  extensionOf,
  normaliseMimeType,
  tidyText,
  type ExtractedDocument,
  type ExtractionRequest,
  type Extractor,
} from './types.js';

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/x-ndjson',
  'text/rtf',
]);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'mdx',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'log',
  'rst',
  'org',
  'adoc',
  'yaml',
  'yml',
]);

/**
 * Decodes bytes to a string, preferring whatever the file says about itself.
 *
 * Exported because the same problem appears wherever bytes become text, and one
 * implementation of "which encoding is this" is easier to be right about than three.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.byteLength >= 2) {
    const [a, b] = [bytes[0]!, bytes[1]!];
    if (a === 0xfe && b === 0xff) return decodeWith(bytes.subarray(2), 'utf-16be');
    if (a === 0xff && b === 0xfe) return decodeWith(bytes.subarray(2), 'utf-16le');
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith(bytes.subarray(3), 'utf-8');
  }

  // UTF-16 without a BOM, which is what Windows Notepad used to produce: ASCII text
  // encoded as two bytes per character leaves every other byte zero.
  if (looksLikeUtf16(bytes)) {
    return decodeWith(bytes, bytes[0] === 0 ? 'utf-16be' : 'utf-16le');
  }

  const utf8 = decodeWith(bytes, 'utf-8');
  // U+FFFD only appears when the decoder gave up. A handful in a long document is a
  // stray byte; a scattering through every Swedish word is latin-1 wearing a UTF-8 hat.
  if (replacementRatio(utf8.text) > 0.002) {
    return decodeWith(bytes, 'windows-1252');
  }
  return utf8;
}

function decodeWith(bytes: Uint8Array, encoding: string): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
}

function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const char of text) if (char === '\ufffd') count += 1;
  return count / text.length;
}

function looksLikeUtf16(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.byteLength, 512);
  if (sample < 4) return false;

  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }

  const half = sample / 2;
  return evenZeros > half * 0.6 || oddZeros > half * 0.6;
}

export class TextExtractor implements Extractor {
  readonly name = 'text';

  supports(input: { mimeType: string; filename: string }): boolean {
    const mime = normaliseMimeType(input.mimeType);
    if (TEXT_MIME_TYPES.has(mime)) return true;
    if (mime.startsWith('text/')) return true;
    return TEXT_EXTENSIONS.has(extensionOf(input.filename));
  }

  async extract(request: ExtractionRequest): Promise<ExtractedDocument> {
    const warnings: string[] = [];
    const { text: decoded, encoding } = decodeText(request.bytes);
    if (encoding !== 'utf-8') {
      warnings.push(`Filen lästes som ${encoding} eftersom den inte var UTF-8.`);
    }

    const text = capCharacters(tidyText(decoded), request.limits, warnings);
    if (text.trim().length === 0) throw noTextFound(request.filename);

    return { text, pageCount: null, warnings, extractor: this.name };
  }
}
