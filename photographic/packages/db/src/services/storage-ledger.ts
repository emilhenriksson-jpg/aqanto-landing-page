/**
 * The storage counter, backed by `app.reserve_storage`.
 *
 * Thin on purpose: the interesting part is the SQL. `reserve` is one function call
 * because the check and the increment must not be separable — two uploads racing to the
 * last megabyte is not hypothetical, it is what a phone retrying a failed 40 MB upload
 * does, and a SELECT followed by an UPDATE lets both through.
 */

import { STORAGE_LIMIT_BYTES } from '@photographic/core';
import type { StorageLedger } from '@photographic/documents';
import type { Pool } from 'pg';

import { queryOne } from '../pool.js';

export class PgStorageLedger implements StorageLedger {
  constructor(
    private readonly pool: Pool,
    private readonly limitBytes: number = STORAGE_LIMIT_BYTES,
  ) {}

  async usage(personId: string): Promise<{
    bytesUsed: number;
    limitBytes: number;
    objectCount: number;
  }> {
    const row = await queryOne<{ bytes_used: string; object_count: number }>(
      this.pool,
      `SELECT bytes_used, object_count FROM app.storage_usage WHERE person_id = $1`,
      [personId],
    );

    return {
      // `bigint` comes back as a string from `pg`, because 2^53 is a real ceiling for a
      // JS number. Coerced here rather than left as a string: every caller does
      // arithmetic on it, and `"0" + 100` is a bug that would only show at the limit.
      bytesUsed: Number(row?.bytes_used ?? 0),
      limitBytes: this.limitBytes,
      objectCount: row?.object_count ?? 0,
    };
  }

  async reserve(input: {
    personId: string;
    checksum: string;
    byteSize: number;
    storageKey: string;
  }): Promise<{
    allowed: boolean;
    deduplicated: boolean;
    bytesUsed: number;
    limitBytes: number;
    objectCount: number;
  }> {
    const row = await queryOne<{
      allowed: boolean;
      deduplicated: boolean;
      bytes_used: string;
      limit_bytes: string;
    }>(
      this.pool,
      `SELECT allowed, deduplicated, bytes_used, limit_bytes
       FROM app.reserve_storage($1, $2, $3, $4, $5)`,
      [input.personId, input.checksum, input.byteSize, input.storageKey, this.limitBytes],
    );

    const usage = await this.usage(input.personId);
    return {
      allowed: row?.allowed ?? false,
      deduplicated: row?.deduplicated ?? false,
      bytesUsed: Number(row?.bytes_used ?? usage.bytesUsed),
      limitBytes: this.limitBytes,
      objectCount: usage.objectCount,
    };
  }

  async release(input: { personId: string; checksum: string }): Promise<boolean> {
    const row = await queryOne<{ released: boolean }>(
      this.pool,
      `SELECT app.release_storage($1, $2) AS released`,
      [input.personId, input.checksum],
    );
    return row?.released ?? false;
  }
}
