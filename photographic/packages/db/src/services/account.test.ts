/**
 * Export and permanent deletion, against a real database.
 *
 * The two decisions under test are the ones that could reasonably have gone the other
 * way, so they are asserted rather than assumed:
 *
 *   - An export of a shared room contains only what the exporting person wrote, unless
 *     they asked for the whole room, and either way the room sees `export.created`.
 *   - A deletion keeps their contributions in shared rooms, pseudonymised, because the
 *     invite consent promised exactly that — and offers `remove` as a real choice,
 *     which is what makes keeping them defensible.
 */

import { DELETION_FREEZE_DAYS } from '@photographic/core';
import type { Actor, PersonId, RoomId } from '@photographic/core';
import { MemoryBlobStore } from '@photographic/documents/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { PgAccounts } from './account.js';
import { PgExports } from './exports.js';

const pool = createPool();
const utf8 = (text: string) => new TextEncoder().encode(text);

let wired: PostgresServices;
let blobs: MemoryBlobStore;
let accounts: PgAccounts;
let exports: PgExports;

let emil: Actor;
let elias: Actor;
let personalRoom: RoomId;
let sharedRoom: RoomId;

beforeEach(async () => {
  await reset(pool);
  blobs = new MemoryBlobStore();
  wired = await createPostgresServices({ pool, blobs });
  accounts = new PgAccounts(pool, blobs);
  exports = new PgExports(pool, blobs);

  const one = await wired.services.identity.register({
    email: 'emil@konto.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(one.person.id);
  personalRoom = one.personalRoom.id;

  const two = await wired.services.identity.register({
    email: 'elias@konto.test',
    displayName: 'Elias',
  });
  elias = wired.actorFor(two.person.id);

  // A shared room both write in: the interesting case for both features.
  const room = await wired.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
  sharedRoom = room.id;
  const invite = await wired.services.invites.create(emil, {
    roomId: sharedRoom,
    channel: 'email',
    destination: 'elias@konto.test',
  });
  await wired.services.invites.accept(
    invite.url.split('/').filter(Boolean).at(-1)!,
    elias.personId,
  );
});

afterAll(async () => {
  await pool.end();
});

/** Writes directly, bypassing the approval tiering, which is not what is under test. */
// A write into a shared room always passes the Godkänn queue (`requiresApproval`,
// build-plan decision 2), so getting a saved memory in one takes two steps rather than
// one. These tests are about what account deletion does to a contribution that is
// already there, not about the gate, so the approval happens here.
async function remember(actor: Actor, roomId: RoomId, body: string): Promise<void> {
  const decision = await wired.services.ingest.remember(actor, { roomId, body, explicit: true });
  if (decision.outcome === 'needs_approval') {
    await wired.services.ingest.resolveProposal(actor, decision.proposal.id, true);
  }
}

async function upload(actor: Actor, roomId: RoomId, filename: string, body: string) {
  return wired.services.documents.upload(actor, {
    roomId,
    filename,
    mimeType: 'text/markdown',
    bytes: utf8(body),
  });
}

const eventsIn = async (roomId: RoomId, type: string) =>
  (await pool.query(`SELECT payload FROM app.event WHERE room_id = $1 AND event_type = $2`, [
    roomId,
    type,
  ])).rows as Array<{ payload: Record<string, unknown> }>;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  it('records a request and runs it to a downloadable archive', async () => {
    await remember(emil, personalRoom, 'allergisk mot ketchup');

    const requested = await exports.request(emil);
    expect(requested.status).toBe('pending');

    const finished = await exports.run(requested.id);
    expect(finished?.status).toBe('ready');
    expect(finished?.byteSize).toBeGreaterThan(0);
    expect(finished?.checksum).toMatch(/^[0-9a-f]{64}$/);
    // The snapshot boundary, so two exports are comparable rather than merely different.
    expect(finished?.throughSeq).toBeGreaterThan(0);
  });

  it('is never produced synchronously', async () => {
    // Reading a whole log and every uploaded file inside a request is a timeout for
    // exactly the people with the most in it.
    const requested = await exports.request(emil);
    expect(requested.status).toBe('pending');
    expect(requested.byteSize).toBeNull();
  });

  it('hands out a signed link that resolves to the archive', async () => {
    const job = await exports.run((await exports.request(emil)).id);
    const link = await exports.createDownloadToken(emil, job!.id);

    expect(link?.token).toMatch(/^pgm_dl_/);

    const resolved = await exports.resolveDownload(link!.token);
    expect(resolved?.filename).toMatch(/^photographic-export-.*\.zip$/);
    // A real zip, not an error page. Read from the stream, because the archive is handed
    // over in pieces now rather than as one buffer.
    const first = await resolved!.stream[Symbol.asyncIterator]().next();
    expect(Buffer.from(first.value!.subarray(0, 2)).toString()).toBe('PK');
  });

  it('stores only a hash of the download token', async () => {
    // A dump of this table must not be a set of working links to people's memory.
    const job = await exports.run((await exports.request(emil)).id);
    const link = await exports.createDownloadToken(emil, job!.id);

    const rows = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM app.export_download`,
    );
    expect(rows.rows[0]?.token_hash).not.toBe(link!.token);
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown or expired link the same way', async () => {
    expect(await exports.resolveDownload('pgm_dl_nonsense')).toBeNull();

    const job = await exports.run((await exports.request(emil)).id);
    const link = await exports.createDownloadToken(emil, job!.id);
    await pool.query(`UPDATE app.export_download SET expires_at = now() - interval '1 hour'`);

    expect(await exports.resolveDownload(link!.token)).toBeNull();
  });

  it('deletes the archive when it expires, not just the row', async () => {
    // A complete copy of someone's memory should not sit in storage after the link
    // stopped working.
    const job = await exports.run((await exports.request(emil)).id);
    const key = (
      await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM app.export_job WHERE id = $1`,
        [job!.id],
      )
    ).rows[0]!.storage_key;

    expect(await blobs.exists(key)).toBe(true);

    await pool.query(`UPDATE app.export_job SET expires_at = now() - interval '1 day'`);
    expect(await exports.expireOld()).toBe(1);
    expect(await blobs.exists(key)).toBe(false);
  });

  it('writes export.created to every room it covered, saying how much it took', async () => {
    await remember(emil, sharedRoom, 'Emils beslut');
    const job = await exports.run((await exports.request(emil)).id);
    expect(job?.status).toBe('ready');

    const inShared = await eventsIn(sharedRoom, 'export.created');
    expect(inShared).toHaveLength(1);
    // The distinction the other members need: their own contributions were not taken.
    expect(inShared[0]?.payload['included']).toBe('own');

    const inPersonal = await eventsIn(personalRoom, 'export.created');
    expect(inPersonal[0]?.payload['included']).toBe('full');
  });

  it('marks a full-transcript export differently, so the stronger act looks stronger', async () => {
    const job = await exports.run(
      (await exports.request(emil, { scope: 'rooms', rooms: [sharedRoom] })).id,
    );
    expect(job?.status).toBe('ready');

    const inShared = await eventsIn(sharedRoom, 'export.created');
    expect(inShared[0]?.payload['included']).toBe('full');
    expect(inShared[0]?.payload['scope']).toBe('rooms');
  });

  it('refuses a room the person is not in, without confirming it exists', async () => {
    const theirs = await wired.services.rooms.create(elias, { title: 'Elias privata projekt' });

    await expect(
      exports.request(emil, { scope: 'rooms', rooms: [theirs.id] }),
    ).rejects.toThrow();
  });

  it('requires a room when a full transcript is asked for', async () => {
    await expect(exports.request(emil, { scope: 'rooms', rooms: [] })).rejects.toThrow(
      /vilka rum/,
    );
  });

  it('includes the uploaded file itself, not only its metadata', async () => {
    await upload(emil, personalRoom, 'anteckningar.md', '# Mina anteckningar\n\nKetchup.');

    const job = await exports.run((await exports.request(emil)).id);
    expect(job?.documentCount).toBe(1);
    // The archive is bigger than the metadata alone would make it.
    expect(job?.byteSize).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe('deletion: the request', () => {
  it('revokes every token the moment it is requested, on both paths', async () => {
    // This is what makes a thirty-day freeze cost nothing in privacy: during it the
    // account is already unreachable.
    await pool.query(
      `INSERT INTO app.oauth_client (client_id, client_name, redirect_uris, client_label, agent_client)
       VALUES ('pgm_client_x', 'Claude', ARRAY['https://x.test/cb'], 'Claude', 'claude-desktop')`,
    );
    await pool.query(
      `INSERT INTO app.oauth_token (token_hash, client_id, person_id, scope, expires_at)
       VALUES ('hash-a', 'pgm_client_x', $1, 'memory.read', now() + interval '1 hour')`,
      [emil.personId],
    );

    const { tokensRevoked } = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });

    expect(tokensRevoked).toBe(1);
    const live = await pool.query(
      `SELECT 1 FROM app.oauth_token WHERE person_id = $1 AND revoked_at IS NULL`,
      [emil.personId],
    );
    expect(live.rowCount).toBe(0);
  });

  it('gives the frozen path thirty days and the immediate path none', async () => {
    const frozen = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });
    const days =
      (frozen.request.executeAfter.getTime() - frozen.request.requestedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(DELETION_FREEZE_DAYS);

    const now = await accounts.requestDeletion(elias, {
      immediate: true,
      contributions: 'keep',
    });
    expect(now.request.executeAfter.getTime()).toBeLessThanOrEqual(
      now.request.requestedAt.getTime() + 1000,
    );
  });

  it('refuses to record a deletion without a decision about contributions', async () => {
    // The consent text says the choice is never preselected. A mandatory column and a
    // validating caller are what turn that from a UI convention into a property of the
    // system — a future script cannot skip it.
    await expect(
      accounts.requestDeletion(emil, {
        immediate: false,
        contributions: undefined as never,
      }),
    ).rejects.toThrow(/keep.*remove|remove.*keep/s);
  });

  it('treats a second request as the same one, not a second sweep', async () => {
    const first = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });
    const again = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });

    expect(again.request.id).toBe(first.request.id);
    // And the original terms stand: a repeat click does not silently escalate to
    // immediate deletion.
    expect(again.request.immediate).toBe(false);
  });

  it('can be cancelled during the freeze, which is the only thing the freeze is for', async () => {
    await accounts.requestDeletion(emil, { immediate: false, contributions: 'keep' });
    expect(await accounts.isFrozen(emil.personId)).toBe(true);

    const cancelled = await accounts.cancelDeletion(emil);
    expect(cancelled?.status).toBe('cancelled');
    expect(await accounts.isFrozen(emil.personId)).toBe(false);
    expect(await accounts.cancelDeletion(emil)).toBeNull();
  });

  it('leaves export working during the freeze', async () => {
    // "Ingen ska behöva välja mellan att få ut sitt minne och att bli av med det."
    await remember(emil, personalRoom, 'något att exportera');
    await accounts.requestDeletion(emil, { immediate: false, contributions: 'keep' });

    const job = await exports.run((await exports.request(emil)).id);
    expect(job?.status).toBe('ready');
  });
});

describe('deletion: what it removes and what it keeps', () => {
  it('hard-deletes the personal room and its files', async () => {
    await remember(emil, personalRoom, 'allergisk mot ketchup');
    const doc = await upload(emil, personalRoom, 'privat.md', '# Privat\n\nInnehåll.');
    const key = (
      await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM app.document WHERE id = $1`,
        [doc.documentId],
      )
    ).rows[0]!.storage_key;

    expect(await blobs.exists(key)).toBe(true);

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    const done = await accounts.executeDeletion(request.id);

    expect(done?.status).toBe('completed');
    // Files before rows: the storage key was the only index into the bytes.
    expect(await blobs.exists(key)).toBe(false);
    expect(
      (await pool.query(`SELECT 1 FROM app.room WHERE id = $1`, [personalRoom])).rowCount,
    ).toBe(0);
  });

  it('keeps contributions in shared rooms, because the invite consent promised that', async () => {
    // The promise made in the first viewport: "det du skriver i ett delat rum blir en
    // del av rummet och stannar där även om du senare lämnar det". A deletion that
    // stripped them would contradict it, and would change what the other members
    // remember behind their backs.
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    const survived = await pool.query<{ body: string; status: string }>(
      `SELECT body, status FROM app.item WHERE room_id = $1`,
      [sharedRoom],
    );
    expect(survived.rows.map((r) => r.body)).toContain('Emils beslut om budgeten');
    expect(survived.rows[0]?.status).toBe('active');
  });

  /**
   * The test that used to pass while the behaviour was broken.
   *
   * It asserted `item.status = 'deleted'`, `purge_after` set and a `delete_reason` — all
   * three of which the old bulk `UPDATE` did set. What it never asked was whether the
   * removal went through the trash, which is what its own comment claimed and what the
   * consent copy promises. It did not: `app.trash` derives from the last lifecycle *event*
   * and the bulk update wrote none, so the contributions were gone from the room, absent
   * from every trash, and hard-deleted by `purge_expired_items` thirty days later.
   *
   * Asserted through `TrashPort` now, in both directions. Reading the column is what let a
   * silent mass deletion look like an ordinary one for as long as it did.
   */
  it('removes them instead when the person chose that, through the ordinary trash', async () => {
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });
    const done = await accounts.executeDeletion(request.id);

    expect(done?.removed['shared_items_trashed']).toBe(1);

    // Visible to the room's owner, which is the whole of "ingen tyst massradering": the
    // other members see it left, and they can put it back.
    const trash = await wired.services.trash.list(elias, { roomId: sharedRoom });
    const entry = trash.find((row) => row.body === 'Emils beslut om budgeten');

    expect(entry).toBeDefined();
    expect(entry?.deleteReason).toContain('Kontot raderades');
    expect(entry?.daysRemaining).toBeGreaterThan(0);
  });

  it('leaves the removal restorable by the room owner for the thirty days', async () => {
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');
    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });
    await accounts.executeDeletion(request.id);

    const entry = (await wired.services.trash.list(elias, { roomId: sharedRoom }))[0]!;
    const restored = await wired.services.trash.restore(elias, entry.shortId, sharedRoom);

    expect(restored.status).toBe('active');
    expect(restored.body).toBe('Emils beslut om budgeten');
    // And the room can read it again, which is the thing an owner actually wanted.
    expect(await wired.services.trash.list(elias, { roomId: sharedRoom })).toEqual([]);
  });

  it('records the departing person as the actor, so the room can see whose left', async () => {
    // Attribution, not bookkeeping: the other members are entitled to know whose
    // contributions went and that it was a choice. This runs before the tombstone for
    // exactly that reason, which is why the sweep's order is load-bearing.
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');
    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });
    await accounts.executeDeletion(request.id);

    const deleted = await pool.query<{ actor_person_id: string; motivation: string }>(
      `SELECT actor_person_id, motivation FROM app.event
       WHERE room_id = $1 AND event_type = 'item.deleted'`,
      [sharedRoom],
    );

    expect(deleted.rows).toHaveLength(1);
    expect(deleted.rows[0]?.actor_person_id).toBe(emil.personId);
    expect(deleted.rows[0]?.motivation).toContain('Kontot raderades');
  });

  it('never touches another member’s contributions, whichever choice was made', async () => {
    await remember(elias, sharedRoom, 'Elias underlag');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });
    await accounts.executeDeletion(request.id);

    // Through the trash rather than the column, for the same reason as above: an empty trash
    // is the assertion that nothing of Elias's was touched.
    expect(await wired.services.trash.list(elias, { roomId: sharedRoom })).toEqual([]);

    const theirs = await wired.services.retrieval.listForRoom(elias, sharedRoom);
    expect(theirs.map((item) => item.body)).toContain('Elias underlag');
  });

  /**
   * Deletion is a dozen SQL statements and two sets of blob deletions that cannot share a
   * transaction with them, so the property worth testing is not that it never fails — it is
   * that a failure anywhere leaves it resumable, and that resuming does not do the finished
   * steps again.
   *
   * The failure is injected rather than simulated: `blobs.delete` throws once, which lands
   * the sweep in the middle, between the contributions step and the personal room.
   */
  it('resumes where it stopped rather than starting over', async () => {
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');
    await upload(emil, personalRoom, 'kontrakt.md', 'Villans kontrakt');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });

    const realDelete = blobs.delete.bind(blobs);
    let thrown = false;
    blobs.delete = async (key: string) => {
      if (!thrown) {
        thrown = true;
        throw new Error('object storage unavailable');
      }
      return realDelete(key);
    };

    await expect(accounts.executeDeletion(request.id)).rejects.toThrow(/object storage/);

    // The contributions step committed before the failure and must not run again — a second
    // pass over an already-trashed memory would mint a second undo token and a second
    // `item.deleted`, which is two log entries for one removal.
    const deletedEvents = await eventsIn(sharedRoom, 'item.deleted');
    expect(deletedEvents).toHaveLength(1);

    blobs.delete = realDelete;
    const done = await accounts.executeDeletion(request.id);

    expect(done?.status).toBe('completed');
    // One count, not two, even though the sweep ran twice.
    expect(done?.removed['shared_items_trashed']).toBe(1);
    expect(await eventsIn(sharedRoom, 'item.deleted')).toHaveLength(1);
  });

  it('will not let two sweeps run one deletion', async () => {
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');
    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'remove',
    });

    // Both start at once. The lease is taken conditionally in SQL, so the second finds the
    // deletion already claimed and declines rather than duplicating the work.
    const [first, second] = await Promise.all([
      accounts.executeDeletion(request.id),
      accounts.executeDeletion(request.id),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await eventsIn(sharedRoom, 'item.deleted')).toHaveLength(1);
  });

  it('refuses to execute a deletion whose freeze has not expired', async () => {
    // The claim carries the freeze condition, so a hand-run sweep cannot execute early. The
    // thirty days are the person's window to change their mind, not a scheduling hint.
    const { request } = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });

    expect(await accounts.executeDeletion(request.id)).toBeNull();
  });

  it('turns the person into a tombstone rather than deleting the row', async () => {
    // Forced by the schema, not chosen: `event.actor_person_id` and `room.created_by`
    // reference `person` without cascade and the log refuses DELETE. Cascading would
    // erase the history of everyone who shared a room with them.
    await remember(emil, sharedRoom, 'Emils beslut');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    const row = await pool.query<{
      display_name: string;
      email: string | null;
      phone: string | null;
      handle: string;
      deleted_at: Date | null;
    }>(`SELECT display_name, email, phone, handle, deleted_at FROM app.person WHERE id = $1`, [
      emil.personId,
    ]);

    expect(row.rowCount).toBe(1);
    expect(row.rows[0]?.display_name).toBe('Borttagen användare');
    expect(row.rows[0]?.email).toBeNull();
    expect(row.rows[0]?.phone).toBeNull();
    expect(row.rows[0]?.handle).toMatch(/^borttagen-/);
    expect(row.rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it('leaves the shared room readable, with the contribution attributed to the tombstone', async () => {
    // The room keeps its meaning; the person is gone. "Borttagen användare sparade …".
    await remember(emil, sharedRoom, 'Emils beslut om budgeten');

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    const history = await pool.query<{ actor_name: string | null; body: string | null }>(
      `SELECT actor_name, body FROM app.activity WHERE room_id = $1 AND body IS NOT NULL`,
      [sharedRoom],
    );
    expect(history.rows.map((r) => r.actor_name)).toContain('Borttagen användare');
  });

  it('ends memberships, so a deleted account is not still a member', async () => {
    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    const live = await pool.query(
      `SELECT 1 FROM app.membership WHERE person_id = $1 AND left_at IS NULL`,
      [emil.personId],
    );
    expect(live.rowCount).toBe(0);
  });

  it('removes credentials, tokens and sessions', async () => {
    await wired.services.sessions.start({
      personId: emil.personId,
      agentClient: 'web',
      transport: 'rest',
    });

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    const done = await accounts.executeDeletion(request.id);

    expect(done?.removed).toHaveProperty('sessions');
    expect(
      (await pool.query(`SELECT 1 FROM app.client_session WHERE person_id = $1`, [emil.personId]))
        .rowCount,
    ).toBe(0);
  });

  it('deletes any export archive, so the deletion is not cosmetic', async () => {
    const job = await exports.run((await exports.request(emil)).id);
    const key = (
      await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM app.export_job WHERE id = $1`,
        [job!.id],
      )
    ).rows[0]!.storage_key;

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    expect(await blobs.exists(key)).toBe(false);
  });

  it('records what it removed, because an erasure nobody can evidence is not one', async () => {
    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    const done = await accounts.executeDeletion(request.id);

    expect(done?.removed).toMatchObject({
      credentials: expect.any(Number),
      oauth_tokens: expect.any(Number),
      sessions: expect.any(Number),
      memberships_ended: expect.any(Number),
    });
    expect(done?.completedAt).toBeInstanceOf(Date);
  });

  it('does not run a request whose freeze has not expired', async () => {
    const { request } = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });

    expect(await accounts.dueDeletions()).toEqual([]);

    await pool.query(
      `UPDATE app.account_deletion SET execute_after = now() - interval '1 day' WHERE id = $1`,
      [request.id],
    );
    expect((await accounts.dueDeletions()).map((r) => r.id)).toEqual([request.id]);
  });

  it('does not run a cancelled request', async () => {
    const { request } = await accounts.requestDeletion(emil, {
      immediate: false,
      contributions: 'keep',
    });
    await accounts.cancelDeletion(emil);

    expect(await accounts.executeDeletion(request.id)).toBeNull();
    expect(
      (await pool.query(`SELECT display_name FROM app.person WHERE id = $1`, [emil.personId]))
        .rows[0]?.display_name,
    ).toBe('Emil');
  });

  it('keeps a file that a shared room still points at', async () => {
    // Content-addressed storage means the same bytes in a personal and a shared room
    // are one object. Deleting it with the personal room would break the shared copy.
    const body = '# Samma fil\n\nExakt samma innehåll.';
    await upload(emil, personalRoom, 'min-kopia.md', body);
    await upload(emil, sharedRoom, 'delad-kopia.md', body);

    const key = (
      await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM app.document WHERE room_id = $1`,
        [sharedRoom],
      )
    ).rows[0]!.storage_key;

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    expect(await blobs.exists(key)).toBe(true);
  });
});

/**
 * The append-only hatch from migration 0014.
 *
 * Widening an invariant that the whole provenance model rests on deserves tests that
 * try to abuse it rather than tests that use it correctly. Each of these is an attempt
 * to get a DELETE through somewhere it should not go.
 */
describe('the erasure hatch stays narrow', () => {
  it('still refuses an ordinary DELETE on the event log', async () => {
    await remember(emil, sharedRoom, 'Emils beslut');

    await expect(
      pool.query(`DELETE FROM app.event WHERE room_id = $1`, [sharedRoom]),
    ).rejects.toThrow(/append-only/);
  });

  it('still refuses an ordinary UPDATE on the event log', async () => {
    await remember(emil, sharedRoom, 'Emils beslut');

    await expect(
      pool.query(`UPDATE app.event SET payload = '{}'::jsonb WHERE room_id = $1`, [sharedRoom]),
    ).rejects.toThrow(/append-only/);
  });

  it('cannot be aimed at a shared room, because it takes a person and not a room', async () => {
    // The guard that makes the hatch safe to exist. A caller holding a room id has no
    // way to reach a shared room's history through here.
    await remember(emil, sharedRoom, 'Emils beslut');
    const before = await pool.query(`SELECT count(*) FROM app.event WHERE room_id = $1`, [
      sharedRoom,
    ]);

    await pool.query(`SELECT app.erase_personal_room($1)`, [emil.personId]);

    const after = await pool.query(`SELECT count(*) FROM app.event WHERE room_id = $1`, [
      sharedRoom,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('refuses a person who has no personal room, rather than deleting something else', async () => {
    const orphan = '00000000-0000-0000-0000-000000000000';
    const result = await pool.query<{ erase_personal_room: number }>(
      `SELECT app.erase_personal_room($1)`,
      [orphan],
    );
    expect(Number(result.rows[0]?.erase_personal_room)).toBe(0);
  });

  it('does not leave the flag set for whatever runs next on the connection', async () => {
    // A flag that outlived the function would turn the append-only log into an
    // ordinary table for the next statement on the same connection.
    await remember(emil, personalRoom, 'något');
    await remember(emil, sharedRoom, 'Emils beslut');

    const client = await pool.connect();
    try {
      await client.query(`SELECT app.erase_personal_room($1)`, [emil.personId]);

      const flag = await client.query<{ setting: string | null }>(
        `SELECT current_setting('app.erasing', true) AS setting`,
      );
      expect(flag.rows[0]?.setting === 'on').toBe(false);

      await expect(
        client.query(`DELETE FROM app.event WHERE room_id = $1`, [sharedRoom]),
      ).rejects.toThrow(/append-only/);
    } finally {
      client.release();
    }
  });

  it('leaves a shared room’s history intact through a whole account deletion', async () => {
    await remember(emil, sharedRoom, 'Emils beslut');
    await remember(elias, sharedRoom, 'Elias underlag');

    const before = await pool.query<{ count: string }>(
      `SELECT count(*) FROM app.event WHERE room_id = $1`,
      [sharedRoom],
    );

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    await accounts.executeDeletion(request.id);

    const after = await pool.query<{ count: string }>(
      `SELECT count(*) FROM app.event WHERE room_id = $1`,
      [sharedRoom],
    );
    // Not fewer. The room's history is its members', and one of them leaving does not
    // change what the others remember.
    expect(Number(after.rows[0]!.count)).toBeGreaterThanOrEqual(Number(before.rows[0]!.count));
  });

  it('removes the personal room’s events, which is the point', async () => {
    await remember(emil, personalRoom, 'allergisk mot ketchup');
    expect(
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*) FROM app.event WHERE room_id = $1`,
            [personalRoom],
          )
        ).rows[0]!.count,
      ),
    ).toBeGreaterThan(0);

    const { request } = await accounts.requestDeletion(emil, {
      immediate: true,
      contributions: 'keep',
    });
    const done = await accounts.executeDeletion(request.id);

    expect(done?.removed['personal_events_erased']).toBeGreaterThan(0);
    expect(
      (await pool.query(`SELECT 1 FROM app.event WHERE room_id = $1`, [personalRoom])).rowCount,
    ).toBe(0);
  });
});
