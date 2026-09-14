import { PhotographicError } from '@photographic/core';

export type ExtractionFailureReason =
  | 'unsupported' // we have no extractor for this type
  | 'too_large' // over an explicit limit, including decompressed size
  | 'corrupt' // the right type, but unreadable
  | 'empty'; // read fine, contained no text (a scan without an OCR layer)

/**
 * Extraction failed. The bytes are still stored: losing someone's document because
 * we could not parse it is the one outcome that is never acceptable here. The
 * message is Swedish because it is shown to the person who uploaded the file.
 */
export class ExtractionError extends PhotographicError {
  constructor(
    message: string,
    readonly reason: ExtractionFailureReason,
  ) {
    super(message, 'extraction_failed', 422);
  }
}

export function unsupportedType(filename: string, mimeType: string): ExtractionError {
  return new ExtractionError(
    `Vi kan inte läsa ut text ur ${describeType(filename, mimeType)} ännu. ` +
      'Filen är sparad och går att ladda ner, men den blir inte sökbar.',
    'unsupported',
  );
}

export function noTextFound(filename: string): ExtractionError {
  return new ExtractionError(
    `Vi hittade ingen text i "${filename}". Är det en inskannad bild behöver den ` +
      'textigenkänning först. Filen är sparad.',
    'empty',
  );
}

export function tooLarge(detail: string): ExtractionError {
  return new ExtractionError(`${detail} Filen är sparad men inte sökbar.`, 'too_large');
}

export function corrupt(filename: string, detail?: string): ExtractionError {
  return new ExtractionError(
    `Kunde inte läsa "${filename}" – filen verkar skadad eller lösenordsskyddad. ` +
      'Filen är sparad.' +
      (detail ? ` (${detail})` : ''),
    'corrupt',
  );
}

function describeType(filename: string, mimeType: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop() : null;
  if (extension && extension.length <= 8) return `.${extension.toLowerCase()}-filer`;
  return `filer av typen ${mimeType || 'okänd'}`;
}
