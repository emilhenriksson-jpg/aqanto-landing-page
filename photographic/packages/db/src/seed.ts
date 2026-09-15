/**
 * Seeds a demo person + shared room so Emil can poke at Postgres without signing up.
 *
 *   DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic \
 *     pnpm --filter @photographic/db seed
 *
 * Idempotent on email: re-running against an already-seeded DB prints the existing
 * person rather than inventing a second Emil.
 */

import { createPool, createPostgresServices, databaseUrl } from './index.js';

const DEMO_EMAIL = 'emil@photographic.me';

async function main(): Promise<void> {
  const pool = createPool({ connectionString: databaseUrl() });
  const wired = await createPostgresServices({
    pool,
    baseUrl: 'https://photographic.me',
  });
  const { services } = wired;

  try {
    const existing = await services.identity.findByEmail(DEMO_EMAIL);
    const { person, personalRoom } = existing
      ? {
          person: existing,
          personalRoom: await services.identity.personalRoomOf(existing.id),
        }
      : await services.identity.register({
          email: DEMO_EMAIL,
          displayName: 'Emil',
        });

    const actor = wired.actorFor(person.id, 'api');

    if (!existing) {
      await services.ingest.remember(actor, {
        roomId: personalRoom.id,
        body: 'Emil, 34, bor i Stockholm',
        kind: 'identity',
        explicit: true,
      });
      await services.ingest.remember(actor, {
        roomId: personalRoom.id,
        body: 'Allergisk mot ketchup',
        kind: 'fact',
        explicit: true,
      });
      await services.ingest.remember(actor, {
        roomId: personalRoom.id,
        body: 'Utmana alltid mina idéer, var inte för positiv',
        kind: 'instruction',
        explicit: true,
      });

      const shared = await services.rooms.create(actor, {
        title: 'Buyersclub Ledning',
        description: 'Beslut och riktning för Buyersclub-förvärvet',
      });
      await services.ingest.remember(actor, {
        roomId: shared.id,
        body: 'Vi beslutade att skjuta förvärvet till Q3',
        kind: 'decision',
        explicit: true,
      });

      await wired.runJobsToCompletion();
      console.log('Seedade demo-data.');
    } else {
      console.log('Demo-personen fanns redan — hoppar över skrivningar.');
    }

    console.log(`person:  ${person.id}`);
    console.log(`email:   ${DEMO_EMAIL}`);
    console.log(`rum:     ${personalRoom.title} (${personalRoom.id})`);
  } finally {
    await wired.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
