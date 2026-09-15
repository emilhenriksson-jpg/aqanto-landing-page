import { apiBase, getSessionToken } from './config.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Thin fetch wrapper: JSON in/out, optional Bearer from `photographic_session`.
 * Paths are absolute under the API origin (`/v1/...`).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  const token = getSessionToken();

  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json().catch(() => null)) as
    | { message?: string; error_description?: string; error?: { message?: string } }
    | null;

  if (!response.ok) {
    const message =
      body?.error?.message ?? body?.error_description ?? body?.message ?? 'Något gick fel.';
    throw new ApiError(message, response.status);
  }

  return body as T;
}
