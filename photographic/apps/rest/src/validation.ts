/**
 * Request parsing. Every route validates with zod and every rejection comes back as a
 * 400 with a Swedish message the person could actually act on, plus machine-readable
 * per-field issues for the client.
 */

import type { Context } from 'hono';
import { z } from 'zod';

import { RequestValidationError, type FieldIssue } from './errors.js';

export function parseWith<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw validationErrorFrom(result.error);
}

export function validationErrorFrom(error: z.ZodError): RequestValidationError {
  const issues = error.issues.map(toFieldIssue);
  return new RequestValidationError(summarise(issues), issues);
}

export async function parseJsonBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  const raw = await readJson(c);
  return parseWith(schema, raw);
}

export function parseParams<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return parseWith(schema, c.req.param());
}

/**
 * Repeated query parameters (`?room=a&room=b`) arrive as arrays and single ones as
 * strings, which is what the schemas in `schemas.ts` are written to accept.
 */
export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const queries = c.req.queries();
  const flattened: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(queries)) {
    if (values.length === 0) continue;
    flattened[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return parseWith(schema, flattened);
}

async function readJson(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  const hasBody = c.req.raw.body !== null;
  if (!hasBody) return {};
  if (contentType && !contentType.includes('json')) {
    throw new RequestValidationError('Ogiltig begäran: kroppen måste vara JSON.', [
      { path: '', message: 'kroppen måste vara JSON' },
    ]);
  }
  try {
    const text = await c.req.text();
    if (text.trim().length === 0) return {};
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError('Ogiltig begäran: kroppen måste vara giltig JSON.', [
      { path: '', message: 'kroppen måste vara giltig JSON' },
    ]);
  }
}

function summarise(issues: FieldIssue[]): string {
  const rendered = issues.map((issue) => issue.message).join('; ');
  return `Ogiltig begäran: ${rendered}.`;
}

function toFieldIssue(issue: z.ZodIssue): FieldIssue {
  const path = issue.path.join('.');
  return { path, message: swedishMessage(issue, path) };
}

function field(path: string): string {
  return path.length > 0 ? `fältet "${path}"` : 'begäran';
}

function swedishMessage(issue: z.ZodIssue, path: string): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined' || issue.received === 'null'
        ? `${field(path)} krävs`
        : `${field(path)} måste vara ${swedishType(issue.expected)}`;

    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return issue.minimum === 1
          ? `${field(path)} får inte vara tomt`
          : `${field(path)} måste innehålla minst ${issue.minimum} tecken`;
      }
      if (issue.type === 'array') return `${field(path)} måste innehålla minst ${issue.minimum} poster`;
      return `${field(path)} måste vara minst ${issue.minimum}`;

    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return `${field(path)} får innehålla högst ${issue.maximum} tecken`;
      if (issue.type === 'array') return `${field(path)} får innehålla högst ${issue.maximum} poster`;
      return `${field(path)} får vara högst ${issue.maximum}`;

    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'uuid') return `${field(path)} måste vara ett giltigt id`;
      if (issue.validation === 'email') return `${field(path)} måste vara en giltig e-postadress`;
      if (issue.validation === 'url') return `${field(path)} måste vara en giltig länk`;
      return `${field(path)} har fel format`;

    case z.ZodIssueCode.invalid_enum_value:
      return `${field(path)} måste vara ett av: ${issue.options.join(', ')}`;

    case z.ZodIssueCode.unrecognized_keys:
      return `okända fält: ${issue.keys.join(', ')}`;

    case z.ZodIssueCode.invalid_union:
      return `${field(path)} har fel format`;

    case z.ZodIssueCode.not_multiple_of:
      return `${field(path)} måste vara en multipel av ${issue.multipleOf}`;

    case z.ZodIssueCode.custom:
      return issue.message;

    default:
      return issue.message;
  }
}

function swedishType(expected: string): string {
  switch (expected) {
    case 'string':
      return 'en text';
    case 'number':
    case 'integer':
      return 'ett tal';
    case 'boolean':
      return 'sant eller falskt';
    case 'array':
      return 'en lista';
    case 'object':
      return 'ett objekt';
    default:
      return expected;
  }
}
