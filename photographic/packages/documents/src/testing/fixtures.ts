/**
 * Real files, built byte by byte.
 *
 * Extraction is the one part of this package where a mock proves nothing: the whole
 * question is whether pdf.js and mammoth can read what arrives, and a fake extractor
 * answers a different question. So the tests get a genuine one-page PDF and a genuine
 * `.docx` — small, but structurally valid enough that the real libraries parse them.
 *
 * Also the only honest way to build a zip bomb to be refused.
 */

import { crc32, deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * A one-page PDF whose text layer contains `lines`.
 *
 * Assembled rather than templated because the cross-reference table holds byte offsets
 * of every object, and a PDF with a wrong xref is exactly the corrupt file the
 * extractor is supposed to reject — which would make this fixture test the failure path
 * by accident.
 */
export function makePdf(lines: string[]): Uint8Array {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '14 TL',
    ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(header + body + xref + trailer, 'latin1'));
}

function escapePdfString(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`);
}

// ---------------------------------------------------------------------------
// Zip, and therefore docx
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Deflate rather than store. Needed for a bomb; irrelevant otherwise. */
  compress?: boolean;
  /**
   * Overrides the uncompressed size written into both headers, without changing the
   * data. This is the lie a zip bomb tells, and the only way to test that we refuse it
   * without shipping a multi-gigabyte fixture.
   */
  declaredSize?: number;
}

export function makeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.compress ? deflateRawSync(entry.data) : entry.data;
    const method = entry.compress ? 8 : 0;
    const size = entry.declaredSize ?? entry.data.byteLength;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // mtime/mdate
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, stored);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8); // flags
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(0, 12); // mtime/mdate
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(stored.byteLength, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.byteLength + name.byteLength + stored.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A `.docx` with one `<w:p>` per entry in `paragraphs`. */
export function makeDocx(paragraphs: Array<{ text: string; style?: string }>): Uint8Array {
  const body = paragraphs
    .map(({ text, style }) => {
      const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
      return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    })
    .join('');

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8'), compress: true },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8'), compress: true },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8'), compress: true },
  ]);
}

/**
 * A small archive whose central directory claims it decompresses to `declaredBytes`.
 *
 * The declared size is what a zip reader allocates against, which is why refusing on
 * the declared size rather than on the file size is the check that matters.
 *
 * Capped at what a 32-bit header field can hold. Anything larger is only expressible
 * through zip64, which `inspectArchive` refuses on sight for exactly this reason.
 */
export function makeZipBomb(declaredBytes: number): Uint8Array {
  return makeZip([
    {
      name: 'word/document.xml',
      data: Buffer.alloc(1024, 0x41),
      compress: true,
      declaredSize: declaredBytes,
    },
  ]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
