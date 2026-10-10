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
});
