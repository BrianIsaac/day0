import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { WordDocumentError, wordToMarkdown } from '../../../../src/docs/readers/word';
import { fixtureBytes } from '../../../fixtures/readers/fake';

/** A stored zip with one entry whose central directory declares this uncompressed size. */
function zipDeclaring(name: string, uncompressedSize: number): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + encoded.length);
  new DataView(local.buffer).setUint32(0, 0x04034b50, true);
  local.set(encoded, 30);
  const central = new Uint8Array(46 + encoded.length);
  const view = new DataView(central.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint32(24, uncompressedSize, true);
  view.setUint16(28, encoded.length, true);
  central.set(encoded, 46);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, 1, true);
  tail.setUint16(10, 1, true);
  tail.setUint32(12, central.length, true);
  tail.setUint32(16, local.length, true);
  return new Uint8Array([...local, ...central, ...end]);
}

/** One part of a package: its bytes, and the uncompressed size its directory entry declares. */
interface ZipPart {
  readonly name: string;
  readonly data: Uint8Array;
  /** The size the directory claims; the true one when absent. */
  readonly declared?: number;
  /** Stored as it is, rather than deflated. */
  readonly stored?: boolean;
}

/** A zip of these parts, each deflated unless it says stored, with a directory that may lie. */
function zipOf(parts: readonly ZipPart[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const packed = part.stored === true ? Buffer.from(part.data) : deflateRawSync(part.data);
    const name = Buffer.from(part.name);
    const declared = part.declared ?? part.data.length;
    const method = part.stored === true ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const whole = Buffer.concat([local, name, packed]);
    locals.push(whole);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += whole.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** The two parts every Word package opens with. */
const PACKAGE_PARTS: readonly ZipPart[] = [
  {
    name: '[Content_Types].xml',
    data: Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  },
  {
    name: '_rels/.rels',
    data: Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
  },
];

/** A `word/document.xml` of one paragraph: this text, then this many spaces. */
function documentXml(text: string, padding = 0): Uint8Array {
  return Buffer.concat([
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}`,
    ),
    Buffer.alloc(padding, 0x20),
    Buffer.from('</w:t></w:r></w:p></w:body></w:document>'),
  ]);
}

describe('a Word document as Markdown', (): void => {
  it('keeps its headings, emphasis, numbered steps and tables, and leaves its pictures out', async (): Promise<void> => {
    const markdown = await wordToMarkdown(fixtureBytes('word', 'escalation-paths.docx'));
    expect(markdown).toBe(
      [
        '# Escalation paths',
        'Call the **duty manager** first.',
        '1.  Page the on-call engineer.\n2.  Post in #incidents.',
        '| Severity | Who |\n| --- | --- |\n| SEV1 | Duty manager |\n| SEV2 | Team lead |',
        '## Out of hours',
        '夜间请致电值班经理。',
      ].join('\n\n'),
    );
    expect(markdown).not.toMatch(/base64|!\[/);
  });

  it('is empty for a document that holds only pictures', async (): Promise<void> => {
    await expect(wordToMarkdown(fixtureBytes('word', 'pictures-only.docx'))).resolves.toBe('');
  });

  it('refuses a file that is not a .docx package, saying what it may be', async (): Promise<void> => {
    // An old .doc renamed, or a document protected with a password, is not a zip.
    const notZip = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(wordToMarkdown(notZip)).rejects.toThrow(WordDocumentError);
    await expect(wordToMarkdown(notZip)).rejects.toThrow(
      'it is not a .docx file Day0 can open: it may be protected with a password, or be an older .doc saved under the newer name',
    );
    await expect(wordToMarkdown(zipDeclaring('readme.txt', 12))).rejects.toThrow(
      'it is not a .docx file Day0 can open',
    );
  });

  it('refuses a package that would unpack to more than Day0 holds, before unpacking it', async (): Promise<void> => {
    await expect(
      wordToMarkdown(zipDeclaring('word/document.xml', 200 * 1024 * 1024)),
    ).rejects.toThrow(
      'its text unpacks to 200 MiB, more than the 64 MiB Day0 unpacks of one document',
    );
  });

  it('refuses a package whose directory understates what a part unpacks to, without unpacking past what it declares (W15-R10)', async (): Promise<void> => {
    // Reader 3's zipbomb.mts: a 72 KiB file whose document part is declared as 4,000 bytes and
    // holds 70 MiB. The directory's sum passes the bound, and the converter would unpack it all.
    const bomb = zipOf([
      ...PACKAGE_PARTS,
      {
        name: 'word/document.xml',
        data: documentXml('Close the quarter.', 70 * 1024 * 1024),
        declared: 4_000,
      },
    ]);
    expect(bomb.length).toBeLessThan(100 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    await expect(wordToMarkdown(bomb)).rejects.toThrow(WordDocumentError);
    await expect(wordToMarkdown(bomb)).rejects.toThrow(
      'it unpacks to more than its own directory says it holds, so Day0 does not open it',
    );
    // Nothing near the 70 MiB was held to find that out.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it('reads a package whose directory is honest, deflated or stored', async (): Promise<void> => {
    for (const stored of [false, true]) {
      const honest = zipOf([
        ...PACKAGE_PARTS,
        { name: 'word/document.xml', data: documentXml('Close the quarter.'), stored },
      ]);
      await expect(wordToMarkdown(honest)).resolves.toBe('Close the quarter.');
    }
  });

  it('refuses a document nested too deeply to convert as a document it does not read (W15-R9)', async (): Promise<void> => {
    const cell = (inner: string): string =>
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p>${inner}</w:tc></w:tr></w:tbl>`;
    let nested = '';
    // Tables inside tables, 600 deep: the document unpacks and reads, and its HTML is past what
    // the Markdown conversion's recursion reaches.
    for (let depth = 0; depth < 600; depth += 1) nested = cell(nested);
    const deep = zipOf([
      ...PACKAGE_PARTS,
      {
        name: 'word/document.xml',
        data: Buffer.from(
          `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${nested}</w:body></w:document>`,
        ),
      },
    ]);
    await expect(wordToMarkdown(deep)).rejects.toThrow(WordDocumentError);
    await expect(wordToMarkdown(deep)).rejects.toThrow('it is laid out too deeply for Day0');
  });
});
