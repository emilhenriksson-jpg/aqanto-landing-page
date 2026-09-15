/**
 * What a failed delivery looks like to the rest of the system.
 *
 * A provider outage is not the person's fault and not a bug in the request, so it is
 * neither a 400 nor a silent success. `DeliveryError` carries a Swedish sentence that is
 * safe to show — the provider's own message never is, because it routinely contains the
 * API key prefix, the account id, or the full recipient address.
 */

import { PhotographicError } from '@photographic/core';

export class DeliveryError extends PhotographicError {
  /** The provider's own words, for the log only. Never rendered to a person. */
  readonly detail: string;

  constructor(detail: string) {
    super('Koden kunde inte skickas just nu. Försök igen om en stund.', 'delivery_failed', 502);
    this.detail = detail;
  }
}
