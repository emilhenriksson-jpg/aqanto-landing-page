#!/usr/bin/env node
/**
 * Prints the seeded Emil account's real session-start package twice: once with
 * "recent" zeroed out, once as `BundlePort.build` actually returns it. See
 * `context-package-demo.md` for what this proves.
 *
 * Run against a migrated + seeded local Postgres:
 *
 *   export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
 *   pnpm db:reset && pnpm db:seed
 *   npx tsx scripts/context-package-demo.mjs
 */

import { createPool, createPostgresServices, databaseUrl } from '../packages/db/src/index.ts';
import { estimateTokens, renderInstructions } from '../packages/agent/src/instructions.ts';

const DEMO_EMAIL = 'emil@photographic.me';

async function main() {
  const pool = createPool({ connectionString: databaseUrl() });
  const wired = await createPostgresServices({ pool, baseUrl: 'https://photographic.me' });
  const { services } = wired;

  try {
    const person = await services.identity.findByEmail(DEMO_EMAIL);
    if (!person) {
      throw new Error(`Ingen seedad person hittades (${DEMO_EMAIL}). Kör "pnpm db:seed" först.`);
    }

    const actor = wired.actorFor(person.id, 'claude-desktop');
    const bundle = await services.bundle.build(actor);

    const before = renderInstructions({ ...bundle, recent: [] });
    const after = renderInstructions(bundle);

    console.log('===== BEFORE (profile + room overview only) =====\n');
    console.log(before);
    console.log('\n\n===== AFTER (+ "recent") =====\n');
    console.log(after);

    console.log('\n\n===== raw bundle.recent (what the seam fetched) =====');
    console.dir(bundle.recent, { depth: null });

    console.log('\n\n===== estimated token counts =====');
    console.log('before:', estimateTokens(before));
    console.log('after: ', estimateTokens(after));
  } finally {
    await wired.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
