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

/**
 * Multipart upload.
 *
 * Separate from `apiFetch` because that one sets a JSON content type, and multipart
 * needs the browser to set the header itself so it can include the boundary. Setting
 * `content-type` by hand on a `FormData` body is the classic way to produce a request
 * the server cannot parse, and the error it produces says nothing about why.
 */
export async function apiUpload<T>(path: string, body: FormData): Promise<T> {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  const token = getSessionToken();

  const response = await fetch(url, {
    method: 'POST',
    body,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  const parsed = (await response.json().catch(() => null)) as
    | { message?: string; error?: { message?: string } }
    | null;

  if (!response.ok) {
    // The storage limit and an oversized file both arrive here with a Swedish message
    // written for the person, so it is passed through rather than replaced with a
    // generic one — "det finns inte plats för …, du har 1,2 GB kvar" is the whole point.
    throw new ApiError(parsed?.error?.message ?? parsed?.message ?? 'Kunde inte ladda upp filen.', response.status);
  }

  return parsed as T;
}
