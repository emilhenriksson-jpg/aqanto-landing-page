/**
 * Export and account deletion.
 *
 * Both are first-party only on the server: no OAuth scope reaches them, so these calls
 * only work from the person's own browser session. That is the reason they live in the
 * product app and nowhere else — a connected model cannot make either request, and it
 * cannot be given the ability to.
 */

import { apiFetch } from './client.js';
import type {
  DeletionReceiptDto,
  DeletionStateDto,
  ExportJobDto,
  ExportLinkDto,
} from './types.js';

/**
 * Queues an export — POST /v1/export.
 *
 * Scope stays `own` here on purpose. A full transcript of a shared room includes other
 * members' writing and is a materially different request; the screen says so, and asking
 * for one is not something this button can do by accident.
 */
export function requestExport(): Promise<{ export: ExportJobDto }> {
  return apiFetch('/v1/export', {
    method: 'POST',
    body: JSON.stringify({ scope: 'own' }),
  });
}

/** GET /v1/export — the person's own export jobs, newest first. */
export function listExports(): Promise<{ exports: ExportJobDto[] }> {
  return apiFetch('/v1/export');
}

/** GET /v1/export/:exportId — one job, for polling while the archive is built. */
export function getExport(exportId: string): Promise<{ export: ExportJobDto }> {
  return apiFetch(`/v1/export/${encodeURIComponent(exportId)}`);
}

/** POST /v1/export/:exportId/link — mints the download URL when the person asks for it. */
export function createExportLink(exportId: string): Promise<ExportLinkDto> {
  return apiFetch(`/v1/export/${encodeURIComponent(exportId)}/link`, { method: 'POST' });
}

/** GET /v1/account/deletion — pending request, if any, plus the consent copy. */
export function getDeletionState(): Promise<DeletionStateDto> {
  return apiFetch('/v1/account/deletion');
}

/**
 * POST /v1/account/deletion.
 *
 * `contributions` has no default in the API and none here: the choice about what happens
 * to what a person wrote in shared rooms is never preselected. `confirm` carries the
 * typed phrase the immediate path requires.
 */
export function requestDeletion(input: {
  contributions: 'keep' | 'remove';
  immediate: boolean;
  confirm?: string;
}): Promise<DeletionReceiptDto> {
  return apiFetch('/v1/account/deletion', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** DELETE /v1/account/deletion — cancels a pending deletion during the freeze. */
export function cancelDeletion(): Promise<{ cancelled: boolean; notice: string }> {
  return apiFetch('/v1/account/deletion', { method: 'DELETE' });
}
