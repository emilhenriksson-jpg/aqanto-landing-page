/**
 * The 10 GB limit, and what a person is told when they reach it.
 *
 * A product limit, not a reserved quota: nothing is allocated up front, a person using
 * 80 MB costs 80 MB, and the number can be raised for a plan or lowered before launch
 * without touching a single stored object. What it is *not* is advisory — it is checked
 * on the upload path, before the document row exists, because a limit enforced at read
 * time is a limit that was never enforced.
 *
 * The counting rule is per person and per distinct object. The blob store is
 * content-addressed, so the same PDF filed into two rooms is one object; charging twice
 * for it would be a bill for storage nobody is using. Deduplication never crosses
 * people: whether someone else already uploaded your file is not something your own
 * usage should be able to reveal.
 */

import { PhotographicError, STORAGE_LIMIT_BYTES } from '@photographic/core';

export { STORAGE_LIMIT_BYTES };

export interface StorageUsage {
  bytesUsed: number;
  limitBytes: number;
  objectCount: number;
}

/**
 * Over the limit. 413 rather than 400: the request was well formed and the file was
 * fine, there is simply no room for it.
 */
export class StorageLimitError extends PhotographicError {
  constructor(
    message: string,
    readonly usage: StorageUsage,
  ) {
    super(message, 'storage_limit_reached', 413);
  }
}

export function storageLimitReached(input: {
  filename: string;
  byteSize: number;
  usage: StorageUsage;
}): StorageLimitError {
  const remaining = Math.max(input.usage.limitBytes - input.usage.bytesUsed, 0);

  return new StorageLimitError(
    `Det finns inte plats för "${input.filename}" (${formatBytes(input.byteSize)}). ` +
      `Du använder ${formatBytes(input.usage.bytesUsed)} av ${formatBytes(input.usage.limitBytes)} ` +
      `och har ${formatBytes(remaining)} kvar. Ta bort något eller hör av dig om du behöver mer plats.`,
    input.usage,
  );
}

/** True when `byteSize` more bytes would still fit. */
export function fitsWithinLimit(usage: StorageUsage, byteSize: number): boolean {
  return usage.bytesUsed + byteSize <= usage.limitBytes;
}

/**
 * Swedish file sizes, for a message a person reads.
 *
 * Powers of 1024 with the short unit names, which is what every file manager they have
 * ever used shows. Decimal comma, because this is Swedish.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${units[unit]}`;
}
