/**
 * Seeds a demo person + shared room so Emil can poke at Postgres without signing up.
 *
 *   DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic \
 *     pnpm --filter @photographic/db seed
 *
 * Idempotent on email: re-running against an already-seeded DB prints the existing
 * person rather than inventing a second Emil.
 *
 * The demo person also carries a demo mobile number, because a mobile number is the only
 * way to sign in. Without one, the seeded account could be read by a script and never
 * logged into — including by the live MCP smoke, whose whole point is to arrive the way a
 * real client does. `070-000 00 00` is not a number anyone holds, so it cannot collide
 * with a real person's.
 */

import { createPool, createPostgresServices, databaseUrl } from './index.js';

const DEMO_EMAIL = 'emil@photographic.me';
const DEMO_PHONE = '+46700000000';

async function main(): Promise<void> {
  const pool = createPool({ connectionString: databaseUrl() });
  const wired = await createPostgresServices({
    pool,
    baseUrl: 'https://photographic.me',
  });
  const { services } = wired;

  try {
    const existing =
      (await services.identity.findByPhone(DEMO_PHONE)) ??
      (await services.identity.findByEmail(DEMO_EMAIL));
    const { person, personalRoom } = existing
      ? {
          person: existing,
          personalRoom: await services.identity.personalRoomOf(existing.id),
        }
      : await services.identity.register({
          email: DEMO_EMAIL,
          phone: DEMO_PHONE,
          displayName: 'Emil',
        });

    // A demo person seeded before sign-in went phone-only has no number and so no way
    // back in. Backfilled here rather than left for someone to discover at a login prompt.
    if (existing && !existing.phone) {
      await pool.query('UPDATE app.person SET phone = $2, updated_at = now() WHERE id = $1', [
        person.id,
        DEMO_PHONE,
      ]);
      person.phone = DEMO_PHONE;
    }

    const actor = wired.actorFor(person.id, 'api');

    // After an e2e postgres reset + empty signup, the demo email can exist with no
    // memories. Refill the personal facts whenever ketchup is missing so MCP smoke
    // against a "seeded" DB does not assert against an empty profile.
    const bundle = await services.bundle.build(actor);
    const rendered = services.bundle.render(bundle);
    const needsPersonalFacts = !rendered.toLowerCase().includes('ketchup');

    if (needsPersonalFacts) {
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
    }

    const rooms = await services.rooms.listForPerson(actor);
    const hasShared = rooms.some((room) => room.title === 'Buyersclub Ledning');
    if (!hasShared) {
      const shared = await services.rooms.create(actor, {
        title: 'Buyersclub Ledning',
        description: 'Beslut och riktning för Buyersclub-förvärvet',
      });

      // Via the approval queue, because that is the only way into a shared room now —
      // seeding around it would give the demo a room in a state the product cannot
      // produce.
      const queued = await services.ingest.remember(actor, {
        roomId: shared.id,
        body: 'Vi beslutade att skjuta förvärvet till Q3',
        kind: 'decision',
        explicit: true,
      });
      if (queued.outcome === 'needs_approval') {
        await services.ingest.resolveProposal(actor, queued.proposal.id, true);
      }
    }

    if (needsPersonalFacts || !hasShared) {
      await wired.runJobsToCompletion();
      console.log(existing ? 'Fyllde på saknad demo-data.' : 'Seedade demo-data.');
    } else {
      console.log('Demo-personen fanns redan — hoppar över skrivningar.');
    }

    console.log(`person:  ${person.id}`);
    console.log(`mobil:   ${DEMO_PHONE}`);
    console.log(`e-post:  ${DEMO_EMAIL} (kontaktuppgift, inte en väg in)`);
    console.log(`rum:     ${personalRoom.title} (${personalRoom.id})`);
  } finally {
    await wired.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
