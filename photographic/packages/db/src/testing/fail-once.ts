/**
 * A pool that rejects the next query whose SQL matches, once.
 *
 * Fault injection between statements, which is the only way to test a transaction boundary:
 * an assertion that a happy path works says nothing about what a process death halfway
 * through leaves behind, and "the state changed but the event never landed" is the shape that
 * made a deleted memory unrecoverable and would do the same to a file.
 *
 * Wraps rather than replaces, so everything else behaves exactly as in production —
 * including the transaction plumbing in `pool.ts`, which recognises a real pool by its
 * `totalCount`. `connect()` hands back a wrapped client because that is where a
 * transaction's statements actually run, and a wrapper that missed that would inject
 * nothing into the case worth testing.
 *
 * One copy, deliberately. This started as the same twenty lines pasted into a second test
 * file, which is how the phone normaliser and the invite screen each became two.
 */

import type { Pool } from 'pg';

type QueryFn = (...args: unknown[]) => Promise<unknown>;

function sqlOf(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first) return String(first.text);
  return '';
}

export interface FailOnce {
  pool: Pool;
  /** Whether the injected failure actually happened, so a test can assert it did. */
  fired: () => boolean;
}

export function failOnce(inner: Pool, matches: RegExp): FailOnce {
  let armed = true;
  let fired = false;

  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);

        if (property === 'query' && typeof value === 'function') {
          const original = value as QueryFn;
          return (...args: unknown[]) => {
            if (armed && matches.test(sqlOf(args))) {
              armed = false;
              fired = true;
              return Promise.reject(new Error('injected failure'));
            }
            return original.apply(object, args);
          };
        }

        if (property === 'connect' && typeof value === 'function') {
          const original = value as (...args: unknown[]) => Promise<object>;
          return async (...args: unknown[]) => wrap(await original.apply(object, args));
        }

        return typeof value === 'function' ? value.bind(object) : value;
      },
    });

  return { pool: wrap(inner), fired: () => fired };
}
