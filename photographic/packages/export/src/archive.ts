/**
 * The archive format, and the rule that decides what goes in it.
 *
 * Build-plan decision 9: an export is the event log plus the files, not the current
 * state. That follows from the log being the truth — an export of `app.item` is an
 * export of a projection, and whoever imports it elsewhere has the present without being
 * able to answer how it got that way. Provenance is half the product and it lives in the
 * log.
 *
 *   photographic-export-<handle>-<ÅÅÅÅ-MM-DD>.zip
 *   ├── README.md              What this is, in Swedish, readable without Photographic
 *   ├── manifest.json          format_version, person, time, rooms, counts, seq range
 *   ├── events.ndjson          The log, one event per line, ordered by seq
 *   ├── items.ndjson           Current state as a projection — convenience, not truth
 *   ├── rooms.json             Rooms, roles, members (display names), timestamps
 *   ├── people.json            People appearing as actors, with display names
 *   ├── documents.ndjson       Document metadata: id, room, filename, mime, sha256, path
 *   └── documents/<room>/<id>-<filename>
 *
 * NDJSON rather than one JSON document, because the log grows without a ceiling and a
 * file that must be parsed whole is unusable for exactly the people with the most in it.
 * One line per event streams out of a cursor and into a reader.
 *
 * `format_version` is in the manifest because the point of exporting your memory is
 * trusting you can still read it in ten years, and a version is what makes that promise
 * checkable rather than hopeful.
 */

/**
 * Bumped when a consumer would break. Additive fields do not bump it; renaming or
 * removing one does, and so does changing what a file contains.
 */
export const EXPORT_FORMAT_VERSION = 1;

export const ARCHIVE_PATHS = {
  readme: 'README.md',
  manifest: 'manifest.json',
  events: 'events.ndjson',
  items: 'items.ndjson',
  rooms: 'rooms.json',
  people: 'people.json',
  documents: 'documents.ndjson',
  documentDir: 'documents',
} as const;

export type ExportScope = 'own' | 'rooms';

export interface ExportedRoom {
  id: string;
  kind: 'personal' | 'shared';
  title: string;
  description: string | null;
  createdAt: string;
  /** The exporting person's role. */
  role: string;
  /**
   * `own` when only this person's contributions are included, `full` for a whole
   * transcript. Per room, because the two can appear in one archive.
   */
  included: 'own' | 'full';
  members: Array<{ personId: string; displayName: string | null; role: string }>;
}

export interface ExportManifest {
  formatVersion: number;
  /** ISO 8601, when the archive was produced. */
  createdAt: string;
  scope: ExportScope;
  person: {
    id: string;
    handle: string | null;
    displayName: string | null;
    email: string | null;
  };
  rooms: ExportedRoom[];
  counts: {
    events: number;
    items: number;
    documents: number;
    files: number;
  };
  /** Inclusive range of `app.event.seq` in `events.ndjson`. Null when there are none. */
  seqRange: { from: number; through: number } | null;
  /**
   * sha256 of every entry, keyed by path in the archive.
   *
   * Every entry except the two that describe the archive: `manifest.json` cannot contain
   * its own digest, and the README is written after it. Both are covered by the zip's own
   * per-entry CRC and by the archive-wide sha256 the export row records.
   */
  checksums: Record<string, string>;
  notes: string[];
}

/** Filesystem-safe, and recognisably the original name. */
export function archiveDocumentPath(input: {
  roomSlug: string;
  documentId: string;
  filename: string;
}): string {
  return `${ARCHIVE_PATHS.documentDir}/${safeSegment(input.roomSlug)}/${input.documentId}-${safeSegment(input.filename)}`;
}

/**
 * Strips what a path separator or a traversal would do to whoever unzips this.
 *
 * A filename is attacker-controlled: it arrived on an uploaded file. An archive member
 * called `../../.bashrc` is a known class of bug in every unzipper that trusts its
 * input, and it costs one function not to be the one who wrote it.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Separators first, then dot runs. Order matters and the other way round is wrong:
    // replacing `/` with `-` first turns `../../.bashrc` into `-..-.bashrc`, where the
    // `..` is no longer leading and a strip-leading-dots rule no longer sees it.
    .replace(/\.{2,}/g, '.')
    .replace(/[/\\]+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'utan-namn';
}

export function archiveFilename(input: { handle: string | null; createdAt: Date }): string {
  const day = input.createdAt.toISOString().slice(0, 10);
  const who = input.handle ? safeSegment(input.handle) : 'photographic';
  return `photographic-export-${who}-${day}.zip`;
}

/** One NDJSON line. Newline-terminated, so concatenation is append. */
export function ndjsonLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/**
 * The README, in Swedish.
 *
 * Written for a person opening the zip in five years with no Photographic account and
 * no memory of this document. So it says what each file is, which one is authoritative,
 * and — the part an export usually omits — what is *not* in here.
 */
export function renderReadme(manifest: ExportManifest): string {
  const sharedFull = manifest.rooms.filter((r) => r.kind === 'shared' && r.included === 'full');
  const sharedOwn = manifest.rooms.filter((r) => r.kind === 'shared' && r.included === 'own');

  const lines = [
    '# Din export från Photographic',
    '',
    `Skapad ${manifest.createdAt.slice(0, 10)}. Formatversion ${manifest.formatVersion}.`,
    '',
    'Det här arkivet går att läsa utan Photographic. Allt är text, och du behöver',
    'inga särskilda verktyg — bara något som kan öppna en zip-fil.',
    '',
    '## Vad som är sanningen',
    '',
    '`events.ndjson` är händelseloggen: en rad per händelse, i den ordning de skedde.',
    'Den är originalet. Allt annat i arkivet går att räkna fram ur den.',
    '',
    '`items.ndjson` är nuläget — vad minnet innehöll när exporten gjordes. Den finns',
    'för bekvämlighet. Om de två någon gång säger olika saker är det loggen som gäller.',
    '',
    '## Filerna',
    '',
    '| Fil | Innehåll |',
    '|---|---|',
    '| `manifest.json` | Formatversion, tidpunkt, rum, antal, sha256 per fil i arkivet |',
    '| `events.ndjson` | Hela loggen, en händelse per rad, sorterad på `seq` |',
    '| `items.ndjson` | Nuläget som projektion |',
    '| `rooms.json` | Rum, roller och medlemmar |',
    '| `people.json` | Personer som förekommer som aktörer |',
    '| `documents.ndjson` | Metadata om dokument, med sökväg i arkivet |',
    '| `documents/` | Originalfilerna, exakt som de laddades upp |',
    '',
    '### NDJSON',
    '',
    'En rad = ett JSON-objekt. Läs rad för rad; filen behöver aldrig läsas in i sin',
    'helhet. I Python:',
    '',
    '```python',
    'import json',
    'with open("events.ndjson", encoding="utf-8") as f:',
    '    for line in f:',
    '        event = json.loads(line)',
    '```',
    '',
    '## Vad som inte finns här',
    '',
    'Text som har raderats permanent är borta. Sådana händelser finns kvar i loggen',
    'med `"redacted": true` — att texten togs bort är i sig ett faktum värt att',
    'exportera, men texten kommer inte tillbaka.',
    '',
  ];

  if (sharedOwn.length > 0) {
    lines.push(
      '### Delade rum: bara dina egna bidrag',
      '',
      'För de här rummen innehåller arkivet det *du* har skrivit, inte hela rummet:',
      '',
      ...sharedOwn.map((room) => `- ${room.title}`),
      '',
      'Ett delat rum är ett gemensamt arbetsminne. Andras anteckningar är deras, inte',
      'dina att ta med. Vill du ha ett helt rum kan du begära det rummet separat — då',
      'ser rummets andra medlemmar att en kopia togs.',
      '',
    );
  }

  if (sharedFull.length > 0) {
    lines.push(
      '### Delade rum: hela innehållet',
      '',
      'De här rummen finns med i sin helhet, inklusive vad andra medlemmar har skrivit:',
      '',
      ...sharedFull.map((room) => `- ${room.title}`),
      '',
      'Du begärde dem uttryckligen, och rummens andra medlemmar ser i rummets historik',
      'att en kopia togs. Det är fortfarande andras uppgifter: behandla dem som',
      'sådana.',
      '',
    );
  }

  if (manifest.notes.length > 0) {
    lines.push('## Noteringar', '', ...manifest.notes.map((note) => `- ${note}`), '');
  }

  return lines.join('\n');
}
