import type { Pool } from 'pg';

/** Separate from OAuth grants: ending a browser session never disconnects an AI. */
export class PgBrowserSessionRevocations {
  constructor(private readonly pool: Pool) {}

  async has(hash: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM app.browser_session_revocation WHERE token_hash = $1 AND expires_at > now()',
      [hash],
    );
    return result.rows.length > 0;
  }

  async add(hash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO app.browser_session_revocation (token_hash, expires_at)
       VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING`,
      [hash, expiresAt],
    );
    await this.pool.query('DELETE FROM app.browser_session_revocation WHERE expires_at <= now()');
  }
}
