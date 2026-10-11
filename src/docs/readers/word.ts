/**
 * A Word document (`.docx`) as Markdown, converted where the reader runs (RM9 (b1), wave 15).
 *
 * Microsoft Graph converts a Word file to PDF or an image only, and asks a write permission to do
 * it, so the SharePoint and Google Drive readers convert the file themselves: `mammoth` (pinned,
 * BSD-2-Clause, pure JavaScript) reads the document's paragraphs, headings, lists and tables as
 * HTML by their Word styles, and the readers' shared helper turns that into Markdown. The page
 * then goes through the same size bound and the same redaction as every page. Pictures are left
 * out, as Day0 reads text. PDFs and slide decks stay unread (B12).
 *
 * A `.docx` is a zip, so before anything is unpacked the package's own directory is read: a file
 * that is not one (an old `.doc` renamed, a document protected with a password) is refused with
 * what it may be, and one whose text would unpack past `MAX_UNPACKED_BYTES` is refused unopened.
 * The directory is then held to its word: each part is unpacked once under the size it declares,
 * so a part that holds more than it says (W15-R10) is refused before the converter, which
 * unpacks whatever a part holds, is given the file.
 */
import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
import {
  DocumentConversionError,
  documentHtmlToMarkdown,
  NESTED_TOO_DEEPLY,
} from './html-markdown';

/** The largest `.docx` file a reader downloads. */
export const MAX_WORD_BYTES = 16 * 1024 * 1024;

/** The most a document's parts, its pictures aside, may unpack to. */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/** Why a Word document was not converted, in words that follow the file's name in a reason. */
export class WordDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WordDocumentError';
  }
}

/** The refusal for a file that is not a Word package. */
function notWord(): WordDocumentError {
  return new WordDocumentError(
    'it is not a .docx file Day0 can open: it may be protected with a password, or be an older ' +
      '.doc saved under the newer name',
  );
}

/** A zip's method number for a deflated part; a stored part, method 0, is its own bytes. */
const DEFLATED = 8;

/** One entry of a zip's central directory. */
interface ZipEntry {
  readonly name: string;
  /** How the part is kept: stored (0), `DEFLATED`, or a method the converter does not read. */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Where the part's own header starts in the file. */
  readonly localOffset: number;
}

/**
 * The entries a zip's central directory declares, read without unpacking anything.
 *
 * @throws WordDocumentError when the bytes are not a zip with a readable directory.
 */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes, or sits before a comment of at most 65,535.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw notWord();
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw notWord();
    const nameLength = view.getUint16(at + 28, true);
    entries.push({
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

/**
 * Hold each deflated part to the size the directory declares for it, by unpacking it under that
 * size and letting it go.
 *
 * A stored part is its own bytes, which the file's size already bounds. A part that does not
 * unpack at all is left to the converter, which words that failure; it cannot unpack to more
 * than was produced here before it failed.
 *
 * @throws WordDocumentError for a part that unpacks past what the directory says it holds.
 */
function holdToDeclaredSizes(bytes: Uint8Array, entries: readonly ZipEntry[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const entry of entries) {
    if (entry.method !== DEFLATED) continue;
    const header = entry.localOffset;
    if (header + 30 > bytes.length || view.getUint32(header, true) !== 0x04034b50) throw notWord();
    const start =
      header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    if (start + entry.compressedSize > bytes.length) throw notWord();
    try {
      inflateRawSync(bytes.subarray(start, start + entry.compressedSize), {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
      });
    } catch (error) {
      if (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new WordDocumentError(
          'it unpacks to more than its own directory says it holds, so Day0 does not open it',
        );
      }
      // Not this failure: a part that does not unpack is the converter's to word.
    }
  }
}

/**
 * Convert a Word document to Markdown.
 *
 * @param bytes - The `.docx` file, at most `MAX_WORD_BYTES`.
 * @returns Its text as Markdown, without its pictures; empty when it holds no text.
 * @throws WordDocumentError when the file is not a Word package, would unpack past the bound or
 *   past what its own directory declares, or converts to more than one page's conversion takes.
 */
export async function wordToMarkdown(bytes: Uint8Array): Promise<string> {
  const entries = zipEntries(bytes);
  if (!entries.some((entry) => entry.name === 'word/document.xml')) throw notWord();
  const unpacked = entries
    .filter((entry) => !entry.name.startsWith('word/media/'))
    .reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new WordDocumentError(
      `its text unpacks to ${Math.ceil(unpacked / (1024 * 1024))} MiB, more than the ` +
        `${MAX_UNPACKED_BYTES / (1024 * 1024)} MiB Day0 unpacks of one document`,
    );
  }
  // Pictures are never unpacked: the converter is given a reader that keeps none of them.
  holdToDeclaredSizes(
    bytes,
    entries.filter((entry) => !entry.name.startsWith('word/media/')),
  );
  let html: string;
  try {
    const converted = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // A picture would be inlined as its bytes; nothing of it is kept.
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
        // A document may name files outside itself; none is read.
        externalFileAccess: false,
      },
    );
    html = converted.value;
  } catch (error) {
    // The converter walks the document by recursion too, and overflows on one nested deeper.
    if (error instanceof RangeError) throw new WordDocumentError(NESTED_TOO_DEEPLY);
    throw new WordDocumentError(
      `it could not be converted (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    return documentHtmlToMarkdown(html.replace(/<img\b[^>]*>/g, ''));
  } catch (error) {
    if (!(error instanceof DocumentConversionError)) throw error;
    throw new WordDocumentError(error.message);
  }
}
