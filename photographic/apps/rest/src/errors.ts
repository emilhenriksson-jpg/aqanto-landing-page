/**
 * Transport-level errors. Domain errors live in `@photographic/core`; these are the
 * few conditions that only exist because there is an HTTP layer at all.
 */

import { PhotographicError, ValidationError } from '@photographic/core';

export interface FieldIssue {
  path: string;
  message: string;
}

/** A zod rejection, carrying the per-field detail the client needs to fix its call. */
export class RequestValidationError extends ValidationError {
  constructor(
    message: string,
    readonly issues: FieldIssue[],
  ) {
    super(message);
  }
}

export class RateLimitError extends PhotographicError {
  constructor(readonly retryAfterSeconds: number) {
    super('För många förfrågningar. Försök igen om en stund.', 'rate_limited', 429);
  }
}

export class PayloadTooLargeError extends PhotographicError {
  constructor(readonly maxBytes: number) {
    super('Filen är för stor.', 'payload_too_large', 413);
  }
}

export class UnsupportedMediaTypeError extends PhotographicError {
  constructor(detail = 'Innehållstypen stöds inte.') {
    super(detail, 'unsupported_media_type', 415);
  }
}

/** Raised by the OAuth stubs until `@photographic/auth` is wired in. */
export class NotImplementedError extends PhotographicError {
  constructor(detail = 'Funktionen är inte tillgänglig ännu.') {
    super(detail, 'not_implemented', 501);
  }
}
