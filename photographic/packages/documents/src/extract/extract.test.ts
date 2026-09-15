import { describe, expect, it } from 'vitest';

import { makeDocx, makePdf, makeZip, makeZipBomb } from '../testing/fixtures.js';
import { DEFAULT_EXTRACTION_LIMITS, extractText, pickExtractor } from './index.js';
import { decodeText } from './text.js';
import { inspectArchive } from './zip.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('pickExtractor', () => {
  it('prefers the specific extractor over the one that claims all text', () => {
    // TextExtractor matches anything `text/*` and would happily decode a PDF into line
    // noise, so registry order is load-bearing rather than cosmetic.
    expect(pickExtractor({ filename: 'a.pdf', mimeType: 'application/pdf' })?.name).toBe('pdf');
    expect(pickExtractor({ filename: 'a.docx', mimeType: 'application/zip' })?.name).toBe('docx');
    expect(pickExtractor({ filename: 'a.html', mimeType: 'text/html' })?.name).toBe('html');
    expect(pickExtractor({ filename: 'a.md', mimeType: 'text/markdown' })?.name).toBe('text');
  });

  it('falls back to the extension when the client sent no usable mime type', () => {
    // Browsers send `application/octet-stream` for a file dragged from some file
    // managers, and the MCP path has no content type at all.
    expect(pickExtractor({ filename: 'avtal.pdf', mimeType: '' })?.name).toBe('pdf');
    expect(pickExtractor({ filename: 'noteringar.md', mimeType: 'application/octet-stream' })?.name).toBe(
      'text',
    );
  });

  it('has nothing for a format we cannot read', () => {
    expect(pickExtractor({ filename: 'bild.png', mimeType: 'image/png' })).toBeNull();
  });
});

describe('text', () => {
  it('extracts plain text and keeps paragraph structure', async () => {
    const result = await extractText({
      bytes: utf8('Första stycket.\n\nAndra stycket.'),
      filename: 'anteckningar.txt',
      mimeType: 'text/plain',
    });

    expect(result.outcome).toBe('extracted');
    expect(result.text).toBe('Första stycket.\n\nAndra stycket.');
    expect(result.extractor).toBe('text');
  });

  it('reads latin-1 rather than filling Swedish words with replacement characters', () => {
    // Windows still produces these, and "Ã¶" where an "ö" belongs is both unreadable
    // and unsearchable.
    const latin1 = new Uint8Array(Buffer.from('Räksmörgås på Österlen', 'latin1'));
    expect(decodeText(latin1).text).toBe('Räksmörgås på Österlen');
  });

  it('reads UTF-16 with a byte order mark', () => {
    const bom = new Uint8Array(Buffer.from('\ufeffHej världen', 'utf16le'));
    expect(decodeText(bom).text).toBe('Hej världen');
  });

  it('reports an empty file as empty rather than as a failure', async () => {
    const result = await extractText({
      bytes: utf8('   \n\n  '),
      filename: 'tom.txt',
      mimeType: 'text/plain',
    });

    expect(result.outcome).toBe('empty');
    expect(result.text).toBe('');
    expect(result.error).toContain('tom.txt');
  });

  it('caps a very long document and says so in Swedish', async () => {
    const result = await extractText(
      { bytes: utf8('a'.repeat(5000)), filename: 'stort.txt', mimeType: 'text/plain' },
      { limits: { ...DEFAULT_EXTRACTION_LIMITS, maxCharacters: 1000 } },
    );

    expect(result.text).toHaveLength(1000);
    expect(result.warnings.join(' ')).toContain('tecknen');
  });
});

describe('html', () => {
  it('turns headings into markdown so the chunker can split on them', async () => {
    const result = await extractText({
      bytes: utf8('<h1>Avtal</h1><p>Gäller från 1 januari.</p><h2>Uppsägning</h2><p>Tre månader.</p>'),
      filename: 'avtal.html',
      mimeType: 'text/html',
    });

    expect(result.text).toContain('# Avtal');
    expect(result.text).toContain('## Uppsägning');
    expect(result.text).toContain('Tre månader.');
  });

  it('drops scripts and styles rather than indexing them as prose', async () => {
    const result = await extractText({
      bytes: utf8('<style>.a{color:red}</style><script>alert(1)</script><p>Riktig text.</p>'),
      filename: 'sida.html',
      mimeType: 'text/html',
    });

    expect(result.text).toBe('Riktig text.');
  });
});

describe('pdf', () => {
  it('extracts the text layer and counts pages', async () => {
    const result = await extractText({
      bytes: makePdf(['Buyersclub Ledning', 'Beslut om budget 2027']),
      filename: 'protokoll.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.outcome).toBe('extracted');
    expect(result.text).toContain('Buyersclub Ledning');
    expect(result.text).toContain('budget 2027');
    expect(result.pageCount).toBe(1);
  });

  it('reports a scanned page as empty, not as a successful empty document', async () => {
    // A PDF with no text layer is the single most common unreadable upload. It must be
    // distinguishable from a document we processed and found nothing interesting in.
    const result = await extractText({
      bytes: makePdf([]),
      filename: 'inskannat.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.outcome).toBe('empty');
    expect(result.error).toContain('textigenkänning');
  });

  it('refuses something that is not a PDF at all', async () => {
    const result = await extractText({
      bytes: utf8('this is not a pdf'),
      filename: 'trasig.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('trasig.pdf');
  });
});

describe('docx', () => {
  it('extracts paragraphs and keeps heading structure', async () => {
    const result = await extractText({
      bytes: makeDocx([
        { text: 'Mallorca', style: 'Heading1' },
        { text: 'Huset är bokat i juli.' },
      ]),
      filename: 'resa.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result.outcome).toBe('extracted');
    expect(result.text).toContain('# Mallorca');
    expect(result.text).toContain('Huset är bokat i juli.');
    expect(result.extractor).toBe('docx');
  });

  it('refuses an archive that claims to decompress to gigabytes', async () => {
    // Just under 4 GB, which is as much as a non-zip64 header can declare. Against a
    // one-kilobyte file that is an expansion ratio of four million.
    const result = await extractText({
      bytes: makeZipBomb(4_000_000_000),
      filename: 'bomb.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('packas upp');
  });

  it('refuses an archive with more entries than we will read', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      name: `word/part${index}.xml`,
      data: Buffer.from('<x/>', 'utf8'),
    }));

    const result = await extractText(
      {
        bytes: makeZip(entries),
        filename: 'många.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { limits: { ...DEFAULT_EXTRACTION_LIMITS, maxArchiveEntries: 10 } },
    );

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('delar');
  });

  it('calls a file that is not a zip corrupt', async () => {
    const result = await extractText({
      bytes: utf8('inte en zip'),
      filename: 'trasig.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('Word-dokument');
  });
});

describe('inspectArchive', () => {
  it('reads the declared sizes from the central directory, not from the data', () => {
    const summary = inspectArchive(makeZipBomb(1_000_000));
    expect(summary.entryCount).toBe(1);
    expect(summary.uncompressedBytes).toBe(1_000_000);
    expect(summary.zip64).toBe(false);
  });
});

describe('unsupported formats', () => {
  it('keeps the file and explains that it will not be searchable', async () => {
    const result = await extractText({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      filename: 'semester.png',
      mimeType: 'image/png',
    });

    expect(result.outcome).toBe('unsupported');
    expect(result.error).toContain('sparad');
    expect(result.error).toContain('.png-filer');
  });

  it('refuses a file over the byte limit before reading any of it', async () => {
    const result = await extractText(
      { bytes: new Uint8Array(2048), filename: 'stor.txt', mimeType: 'text/plain' },
      { limits: { ...DEFAULT_EXTRACTION_LIMITS, maxBytes: 1024 } },
    );

    expect(result.outcome).toBe('failed');
    expect(result.extractor).toBeNull();
  });
});
