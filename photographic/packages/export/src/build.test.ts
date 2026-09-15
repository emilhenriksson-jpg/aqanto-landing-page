/**
 * What ends up in the archive.
 *
 * Most of this file is about the scope rule, because that is the one decision here that
 * could reasonably have gone the other way: a shared room contributes only what the
 * exporting person wrote, unless they explicitly asked for the whole room. The tests
 * name both halves so a future change has to argue with them rather than slip past.
 *
 * Read through Python's `zipfile` rather than our own reader — an archive our own code
 * agrees with proves nothing about whether anyone else can open it.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { MemoryBlobStore } from '@photographic/documents/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildExportArchive } from './build.js';
import { EXPORT_FORMAT_VERSION, safeSegment, type ExportManifest } from './archive.js';
import type { ExportDocument, ExportEvent, ExportItem, ExportRoom, ZipSink } from './index.js';
import { MemoryExportSource, type SeedData } from './testing/index.js';

const run = promisify(execFile);

const EMIL = 'person-emil';
const ELIAS = 'person-elias';
const PERSONAL = 'room-personal';
const LEDNING = 'room-ledning';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photographic-export-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class BufferSink implements ZipSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks.map((c) => Buffer.from(c)));
  }
}

const at = (n: number) => new Date(Date.UTC(2026, 8, 14, 12, n));

function event(partial: Partial<ExportEvent> & { seq: number; roomId: string }): ExportEvent {
  return {
    id: `evt-${partial.seq}`,
    eventType: 'item.created',
    payload: {},
    actorPersonId: EMIL,
    agentClient: 'claude-desktop',
    sessionRef: null,
    approvedBy: null,
    occurredAt: at(partial.seq),
    ...partial,
  };
}

function item(partial: Partial<ExportItem> & { id: string; roomId: string }): ExportItem {
  return {
    shortId: `p-${partial.id.slice(-4)}`,
    kind: 'fact',
    body: 'något',
    status: 'active',
    sensitivity: 'normal',
    validFrom: at(1),
    validTo: null,
    supersededBy: null,
    createdAt: at(1),
    updatedAt: at(1),
    ...partial,
  };
}

function document(
  partial: Partial<ExportDocument> & { id: string; roomId: string; storageKey: string },
): ExportDocument {
  return {
    filename: 'protokoll.pdf',
    mimeType: 'application/pdf',
    byteSize: 8,
    checksum: 'abc',
    uploadedBy: EMIL,
    createdAt: at(2),
    extraction: 'extracted',
    text: 'Uppsägningstiden är tre månader.',
    summary: 'Ett protokoll.',
    ...partial,
  };
}

function rooms(): ExportRoom[] {
  return [
    {
      id: PERSONAL,
      slug: 'emil',
      kind: 'personal',
      title: 'Emil',
      description: null,
      createdAt: at(0),
      role: 'owner',
      members: [{ personId: EMIL, displayName: 'Emil', role: 'owner' }],
    },
    {
      id: LEDNING,
      slug: 'buyersclub-ledning',
      kind: 'shared',
      title: 'Buyersclub Ledning',
      description: 'Styrelsearbetet',
      createdAt: at(0),
      role: 'editor',
      members: [
        { personId: EMIL, displayName: 'Emil', role: 'owner' },
        { personId: ELIAS, displayName: 'Elias', role: 'editor' },
      ],
    },
  ];
}

/** Emil and Elias both write in the shared room; Emil has a private room of his own. */
function seed(): SeedData {
  return {
    people: [
      { id: EMIL, handle: 'emil', displayName: 'Emil', email: 'emil@example.com' },
      { id: ELIAS, handle: 'elias', displayName: 'Elias', email: 'elias@example.com' },
    ],
    rooms: rooms(),
    events: [
      event({ seq: 1, roomId: PERSONAL, payload: { item_id: 'item-private', body: 'ketchup' } }),
      event({ seq: 2, roomId: LEDNING, payload: { item_id: 'item-emil', body: 'Emils beslut' } }),
      event({
        seq: 3,
        roomId: LEDNING,
        actorPersonId: ELIAS,
        payload: { item_id: 'item-elias', body: 'Elias underlag' },
      }),
      event({ seq: 4, roomId: LEDNING, eventType: 'document.uploaded', payload: { document_id: 'doc-emil' } }),
    ],
    items: [
      item({ id: 'item-private', roomId: PERSONAL, body: 'allergisk mot ketchup' }),
      item({ id: 'item-emil', roomId: LEDNING, body: 'Emils beslut om budget' }),
      item({ id: 'item-elias', roomId: LEDNING, body: 'Elias underlag för förvärvet' }),
    ],
    documents: [
      document({ id: 'doc-emil', roomId: LEDNING, storageKey: 'key-emil', filename: 'protokoll.pdf' }),
      document({
        id: 'doc-elias',
        roomId: LEDNING,
        storageKey: 'key-elias',
        uploadedBy: ELIAS,
        filename: 'underlag.pdf',
      }),
    ],
  };
}

async function build(options: { scope?: 'own' | 'rooms'; requestedRooms?: string[] } = {}) {
  const data = seed();
  const blobs = new MemoryBlobStore();
  await blobs.put(new TextEncoder().encode('EMIL-PDF'));
  await blobs.put(new TextEncoder().encode('ELIAS-PDF'));

  // Keys are content-addressed in the real store; the seed names them directly, so map
  // them onto whatever the fake produced.
  const keyed = new MemoryBlobStore();
  const emilKey = (await keyed.put(new TextEncoder().encode('EMIL-PDF'))).key;
  const eliasKey = (await keyed.put(new TextEncoder().encode('ELIAS-PDF'))).key;
  data.documents[0]!.storageKey = emilKey;
  data.documents[1]!.storageKey = eliasKey;

  const sink = new BufferSink();
  const result = await buildExportArchive(
    {
      source: new MemoryExportSource(data),
      blobs: keyed,
      now: () => at(30),
      // Tiny, so paging is genuinely exercised on every stream.
      pageSize: 2,
    },
    {
      personId: EMIL,
      scope: options.scope ?? 'own',
      ...(options.requestedRooms ? { requestedRooms: options.requestedRooms } : {}),
    },
    sink,
  );

  const archive = join(dir, 'export.zip');
  await writeFile(archive, sink.bytes());

  const read = async (name: string): Promise<string> =>
    (
      await run('python3', [
        '-c',
        'import sys,zipfile\n' +
          `sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(${JSON.stringify(name)}).decode("utf-8"))`,
        archive,
      ])
    ).stdout;

  const names = async (): Promise<string[]> =>
    (
      await run('python3', [
        '-c',
        'import sys,zipfile\nprint("\\n".join(i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist()))',
        archive,
      ])
    ).stdout
      .split('\n')
      .filter(Boolean);

  const ndjson = async (name: string): Promise<Array<Record<string, unknown>>> =>
    (await read(name))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const manifest = async (): Promise<ExportManifest> =>
    JSON.parse(await read('manifest.json')) as ExportManifest;

  return { result, archive, read, names, ndjson, manifest };
}

describe('the archive', () => {
  it('opens with a standard reader and contains every promised file', async () => {
    const archive = await build();
    const names = await archive.names();

    expect(names).toContain('README.md');
    expect(names).toContain('manifest.json');
    expect(names).toContain('events.ndjson');
    expect(names).toContain('items.ndjson');
    expect(names).toContain('rooms.json');
    expect(names).toContain('people.json');
    expect(names).toContain('documents.ndjson');

    // `unzip -t` verifies every CRC, which is what catches a streaming bug.
    const tested = await run('unzip', ['-t', archive.archive]);
    expect(tested.stdout).toContain('No errors detected');
  });

  it('carries a format version, because the promise is that this is readable in ten years', async () => {
    const manifest = await (await build()).manifest();
    expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
  });

  it('names the seq range, so two exports are comparable rather than merely different', async () => {
    const manifest = await (await build()).manifest();
    expect(manifest.seqRange).toEqual({ from: 1, through: 4 });
  });

  it('checksums every entry', async () => {
    const manifest = await (await build()).manifest();

    expect(Object.keys(manifest.checksums)).toContain('events.ndjson');
    for (const digest of Object.values(manifest.checksums)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('reports the whole archive checksum and size', async () => {
    const { result } = await build();
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteSize).toBeGreaterThan(0);
  });

  it('writes NDJSON one object per line, streamable without parsing the whole file', async () => {
    const events = await (await build()).ndjson('events.ndjson');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty('seq');
    expect(events[0]).toHaveProperty('event_type');
  });

  it('names the archive after the person and the day', async () => {
    const { result } = await build();
    expect(result.filename).toBe('photographic-export-emil-2026-09-14.zip');
  });
});

describe('the log is the truth, and the projection is labelled as convenience', () => {
  it('includes the event log', async () => {
    // Build-plan decision 9. An export of `items` alone is an export of a projection:
    // the present without any way to answer how it got that way.
    const events = await (await build()).ndjson('events.ndjson');
    expect(events.map((e) => e.seq)).toContain(1);
  });

  it('says in the README which file wins when the two disagree', async () => {
    const readme = await (await build()).read('README.md');
    expect(readme).toContain('events.ndjson');
    expect(readme).toMatch(/originalet|loggen som gäller/);
  });

  it('keeps the extracted text and the AI summary as separate fields', async () => {
    const docs = await (await build()).ndjson('documents.ndjson');
    const doc = docs[0]!;

    expect(doc['extracted_text']).toContain('Uppsägningstiden');
    expect(doc['ai_summary']).toBe('Ett protokoll.');
    expect(doc['extracted_text']).not.toBe(doc['ai_summary']);
  });
});

describe('scope: own — the default', () => {
  it('includes the personal room in full', async () => {
    const items = await (await build()).ndjson('items.ndjson');
    expect(items.map((i) => i['id'])).toContain('item-private');
  });

  it('includes what the person wrote in a shared room', async () => {
    const items = await (await build()).ndjson('items.ndjson');
    expect(items.map((i) => i['id'])).toContain('item-emil');
  });

  it('leaves out what another member wrote in that same room', async () => {
    // The contested decision, stated as a test. A shared room is a collective working
    // memory — the premise that keeps a departing member's notes in it — and that does
    // not stop applying when the copy is going the other way.
    const items = await (await build()).ndjson('items.ndjson');
    expect(items.map((i) => i['id'])).not.toContain('item-elias');
  });

  it('leaves out another member’s events in that room', async () => {
    const events = await (await build()).ndjson('events.ndjson');
    const actors = new Set(events.map((e) => e['actor_person_id']));

    expect(actors).toContain(EMIL);
    expect(actors).not.toContain(ELIAS);
  });

  it('leaves out another member’s uploaded file', async () => {
    const archive = await build();
    const names = await archive.names();

    expect(names.some((name) => name.includes('protokoll.pdf'))).toBe(true);
    expect(names.some((name) => name.includes('underlag.pdf'))).toBe(false);
  });

  it('still describes the room and who is in it', async () => {
    // Who you share a room with is yours to know, and it is display names rather than
    // contact details — so an `own` export is not stripped of context, only of other
    // people's writing.
    const manifest = await (await build()).manifest();
    const shared = manifest.rooms.find((room) => room.id === LEDNING)!;

    expect(shared.included).toBe('own');
    expect(shared.members.map((m) => m.displayName)).toEqual(['Emil', 'Elias']);
  });

  it('tells the person in the README that the room is only partly included', async () => {
    const readme = await (await build()).read('README.md');
    expect(readme).toContain('bara dina egna bidrag');
    expect(readme).toContain('Buyersclub Ledning');
  });

  it('does not leak another member’s email address', async () => {
    const people = JSON.parse(await (await build()).read('people.json')) as Array<
      Record<string, unknown>
    >;

    const elias = people.find((p) => p['id'] === ELIAS);
    expect(elias).toBeDefined();
    expect(elias).not.toHaveProperty('email');

    const self = people.find((p) => p['id'] === EMIL);
    expect(self?.['email']).toBe('emil@example.com');
  });
});

describe('scope: rooms — the explicit, stronger request', () => {
  it('includes the whole room when it was asked for by id', async () => {
    const archive = await build({ scope: 'rooms', requestedRooms: [LEDNING] });
    const items = await archive.ndjson('items.ndjson');

    expect(items.map((i) => i['id'])).toContain('item-elias');
    expect((await archive.names()).some((n) => n.includes('underlag.pdf'))).toBe(true);
  });

  it('includes the other member’s events too', async () => {
    const events = await (
      await build({ scope: 'rooms', requestedRooms: [LEDNING] })
    ).ndjson('events.ndjson');

    expect(new Set(events.map((e) => e['actor_person_id']))).toContain(ELIAS);
  });

  it('marks the room as fully included and says so in the README', async () => {
    const archive = await build({ scope: 'rooms', requestedRooms: [LEDNING] });
    const manifest = await archive.manifest();

    expect(manifest.rooms.find((r) => r.id === LEDNING)?.included).toBe('full');
    expect(manifest.notes.join(' ')).toContain('andra medlemmar');

    const readme = await archive.read('README.md');
    expect(readme).toContain('hela innehållet');
    expect(readme).toMatch(/andras uppgifter|behandla dem som/);
  });

  it('reports which rooms were touched and how, for the export.created events', async () => {
    const { result } = await build({ scope: 'rooms', requestedRooms: [LEDNING] });

    expect(result.touchedRooms).toEqual(
      expect.arrayContaining([
        { roomId: PERSONAL, included: 'full' },
        { roomId: LEDNING, included: 'full' },
      ]),
    );
  });

  it('ignores a room id the person cannot reach', async () => {
    // A room named in a request is a request, never a grant — the same rule the rest of
    // the product follows for a room id supplied by a model.
    const archive = await build({ scope: 'rooms', requestedRooms: ['room-someone-elses'] });
    const manifest = await archive.manifest();

    expect(manifest.rooms.map((r) => r.id)).toEqual([PERSONAL, LEDNING]);
    expect(manifest.rooms.find((r) => r.id === LEDNING)?.included).toBe('own');
  });

  it('does not widen the personal room, which was already whole', async () => {
    const manifest = await (await build({ scope: 'rooms', requestedRooms: [LEDNING] })).manifest();
    expect(manifest.rooms.find((r) => r.id === PERSONAL)?.included).toBe('full');
  });
});

describe('a file the storage layer has lost', () => {
  it('is noted in the archive rather than failing the whole export', async () => {
    // Twelve years of someone's memory should not be withheld over one missing file.
    // A silent gap would be worse: the note says which file, so it can be chased.
    const data = seed();
    const blobs = new MemoryBlobStore();
    data.documents[0]!.storageKey = 'sha256/ff/ff/gone';
    data.documents = [data.documents[0]!];

    const sink = new BufferSink();
    const result = await buildExportArchive(
      { source: new MemoryExportSource(data), blobs, now: () => at(30), pageSize: 2 },
      { personId: EMIL, scope: 'own' },
      sink,
    );

    expect(result.manifest.notes.join(' ')).toContain('protokoll.pdf');
    expect(result.manifest.counts.files).toBe(0);
    // Metadata stays, so the loss is visible rather than invisible.
    expect(result.manifest.counts.documents).toBe(1);
  });
});

describe('safeSegment', () => {
  it('refuses a filename that would escape the archive', async () => {
    // An uploaded filename is attacker-controlled, and an entry called `../../.bashrc`
    // is a known bug in every unzipper that trusts its input.
    expect(safeSegment('../../.bashrc')).not.toContain('..');
    expect(safeSegment('../../.bashrc')).not.toContain('/');
    expect(safeSegment('a/b\\c.pdf')).toBe('a-b-c.pdf');
  });

  it('keeps Swedish characters', () => {
    expect(safeSegment('avtal-uppsägning.pdf')).toBe('avtal-uppsägning.pdf');
  });

  it('never returns an empty segment', () => {
    expect(safeSegment('...')).toBe('utan-namn');
    expect(safeSegment('   ')).toBe('utan-namn');
  });
});
