/**
 * Where the home's export is saved (wave 17, 17-F; decision F-1). A browser with the File System
 * Access API is asked where to save once, at the press, and each piece of the file is written
 * there as it arrives, so the page never holds the whole file. A browser without it keeps the
 * pieces until the file is whole and then downloads it, up to a bound it says when it is passed.
 * Either way a stopped export leaves no file.
 */

import { log } from '@/lib/logger';

/** The most a browser without the File System Access API keeps before it saves: 512 MiB. */
export const HELD_EXPORT_BYTES = 512 * 1024 * 1024;

/**
 * What a browser that must hold the whole file says once the export passes what it can hold
 * (section 7's drafts name the export's other lines; this one is this unit's, flagged).
 */
export const EXPORT_TOO_LARGE =
  'This export is too large for this browser to hold before it saves it. Export from Chrome or Edge, which save it as it arrives, or ask IT to run the export from the command line.';

/** A file the export is being written to. */
export interface ExportFile {
  /** Write the next piece of the file. */
  write(chunk: string): Promise<void>;
  /**
   * The file is whole: keep it.
   *
   * @param fileName - What to call it where the manager was not asked.
   * @returns The name it was saved under.
   */
  close(fileName: string): Promise<string>;
  /**
   * The export stopped: leave no file. It never rejects, so the reason the export stopped is the
   * one said.
   *
   * @returns The name of an empty file it could not remove, or undefined when nothing is left.
   */
  discard(): Promise<string | undefined>;
}

/** How long a held file's address is kept after the download is started, before it is let go. */
const DOWNLOAD_ADDRESS_KEPT_MS = 60_000;

/** A reason a file operation was refused, for the log: the error's name, never its message. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** The picker of the File System Access API, which the DOM's own types do not carry yet. */
type SaveFilePicker = (options: {
  readonly suggestedName: string;
  readonly types: ReadonlyArray<{
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }>;
}) => Promise<FileSystemFileHandle>;

/** A file handle as Chromium has it: `remove` deletes the file the handle names. */
type RemovableFileHandle = FileSystemFileHandle & { remove?: () => Promise<void> };

/** The window's picker, where the browser has one. */
function saveFilePicker(): SaveFilePicker | undefined {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : undefined;
}

/** Whether a rejection is the manager closing the picker without choosing a file. */
function isDismissal(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * A file the manager chose, written as each piece arrives. The pieces go to the browser's own
 * temporary copy until `close`, so a stopped export never leaves half a file under the chosen
 * name; where the picker made a new, empty file for the name, a stopped export removes it too.
 */
async function pickedFile(handle: RemovableFileHandle): Promise<ExportFile> {
  // An existing file the manager chose to replace is theirs and stays if the export stops. The
  // browser does not say whether the picker made the file, so an empty one is read as made by it:
  // an empty file chosen for replacing held nothing to keep.
  const madeByPicker = (await handle.getFile()).size === 0;
  const writable = await handle.createWritable();
  return {
    write: async (chunk) => await writable.write(chunk),
    close: async () => {
      await writable.close();
      return handle.name;
    },
    discard: async () => {
      try {
        await writable.abort();
      } catch (error) {
        // The pieces were in the browser's own temporary copy either way: the name still holds
        // what it held when it was picked.
        log.warn('the unfinished export could not be aborted', { reason: reasonOf(error) });
      }
      if (!madeByPicker) return undefined;
      if (handle.remove === undefined) return handle.name;
      try {
        await handle.remove();
        return undefined;
      } catch (error) {
        log.warn('the empty file the picker made could not be removed', {
          reason: reasonOf(error),
        });
        return handle.name;
      }
    },
  };
}

/**
 * A file held piece by piece until it is whole, then downloaded: each piece becomes a `Blob`,
 * which the browser may keep outside the page's own memory, and nothing is downloaded unless the
 * export finishes.
 *
 * @param maxBytes - The most it holds before it refuses the next piece.
 */
function heldFile(maxBytes: number): ExportFile {
  let pieces: Blob[] = [];
  let bytes = 0;
  return {
    write: async (chunk) => {
      const piece = new Blob([chunk]);
      bytes += piece.size;
      if (bytes > maxBytes) throw new Error(EXPORT_TOO_LARGE);
      pieces.push(piece);
      await Promise.resolve();
    },
    close: async (fileName) => {
      const url = URL.createObjectURL(new Blob(pieces, { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      pieces = [];
      // Kept a minute: a browser that has not yet started a large download when its address goes
      // cancels it.
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_ADDRESS_KEPT_MS);
      return await Promise.resolve(fileName);
    },
    discard: async () => {
      pieces = [];
      return await Promise.resolve(undefined);
    },
  };
}

/**
 * Open the file an export is saved to. Called inside the press that starts the export: the
 * browser's picker opens only on the manager's own gesture.
 *
 * @param suggestedName - The name the picker offers.
 * @param maxBytes - The most a browser without the picker holds before it refuses.
 * @returns The file, or undefined when the manager closed the picker without choosing one.
 */
export async function openExportFile(
  suggestedName: string,
  maxBytes: number = HELD_EXPORT_BYTES,
): Promise<ExportFile | undefined> {
  const picker = saveFilePicker();
  if (picker === undefined) return heldFile(maxBytes);
  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName,
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
  } catch (error) {
    if (isDismissal(error)) return undefined;
    // The picker is there and may not be used here (a frame without the permission, a policy):
    // the file is held and downloaded instead, as in a browser without it.
    log.warn('the save picker could not be used; the export is held and downloaded', {
      reason: reasonOf(error),
    });
    return heldFile(maxBytes);
  }
  return await pickedFile(handle);
}
