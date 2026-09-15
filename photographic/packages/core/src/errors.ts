export class PhotographicError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown whenever an actor reaches for something outside their memberships.
 * Adapters must render this as 404, never 403: confirming that a room exists is
 * already a leak.
 */
export class NotPermittedError extends PhotographicError {
  constructor(detail = 'not found') {
    super(detail, 'not_found', 404);
  }
}

export class NotFoundError extends PhotographicError {
  constructor(detail = 'not found') {
    super(detail, 'not_found', 404);
  }
}

export class ValidationError extends PhotographicError {
  constructor(detail: string) {
    super(detail, 'invalid_request', 400);
  }
}

export class ConflictError extends PhotographicError {
  constructor(detail: string) {
    super(detail, 'conflict', 409);
  }
}

export class AuthError extends PhotographicError {
  constructor(detail = 'unauthorized') {
    super(detail, 'unauthorized', 401);
  }
}
