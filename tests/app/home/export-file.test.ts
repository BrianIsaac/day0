/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_TOO_LARGE, openExportFile } from '../../../app/home/export-file';

/** What the page handed the browser to download. */
const downloaded: { blobs: Blob[]; names: string[] } = { blobs: [], names: [] };

beforeEach((): void => {
  downloaded.blobs = [];
  downloaded.names = [];
  URL.createObjectURL = (blob: Blob): string => {
    downloaded.blobs.push(blob);
    return 'blob:export';
  };
  URL.revokeObjectURL = (): void => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.names.push(this.download);
  });
});

afterEach((): void => {
  vi.restoreAllMocks();
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe('the file the home’s export is saved to (wave 17, 17-F; decision F-1)', (): void => {
  it('holds the pieces in a browser without the picker and downloads them as one file once whole', async (): Promise<void> => {
    const file = await openExportFile('suggested.json');
    await file?.write('{"a":');
    await file?.write('1}\n');
    expect(downloaded.names).toEqual([]);

    expect(await file?.close('day0-owner-export-2026-10-13.json')).toBe(
      'day0-owner-export-2026-10-13.json',
    );
    expect(downloaded.names).toEqual(['day0-owner-export-2026-10-13.json']);
    expect(downloaded.blobs[0]?.type).toBe('application/json');
    expect(await downloaded.blobs[0]?.text()).toBe('{"a":1}\n');
  });

  it('refuses the piece that passes what it can hold, with its sentence, and downloads nothing', async (): Promise<void> => {
    const file = await openExportFile('suggested.json', 10);
    await file?.write('12345');
    await expect(file?.write('6789012')).rejects.toThrow(EXPORT_TOO_LARGE);
    expect(await file?.discard()).toBeUndefined();
    expect(downloaded.names).toEqual([]);
    expect(EXPORT_TOO_LARGE).toBe(
      'This export is too large for this browser to hold before it saves it. Export from Chrome or Edge, which save it as it arrives, or ask IT to run the export from the command line.',
    );
  });

  it('counts what it holds in bytes, not characters', async (): Promise<void> => {
    const file = await openExportFile('suggested.json', 5);
    // Two characters, six bytes.
    await expect(file?.write('日本')).rejects.toThrow(EXPORT_TOO_LARGE);
  });

  it('holds and downloads where the picker is there and may not be used', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (): Promise<never> =>
      await Promise.reject(new DOMException('Must be handling a user gesture.', 'SecurityError'));
    const file = await openExportFile('suggested.json');
    await file?.write('{}\n');
    await file?.close('held.json');
    expect(downloaded.names).toEqual(['held.json']);
  });

  it('keeps the download’s address for a minute, so a browser slow to start a large download still finds it', async (): Promise<void> => {
    vi.useFakeTimers();
    const revoked: string[] = [];
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
    };
    const file = await openExportFile('suggested.json');
    await file?.write('{}\n');
    await file?.close('held.json');
    vi.advanceTimersByTime(59_999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:export']);
    vi.useRealTimers();
  });

  it('answers no file when the manager closes the picker', async (): Promise<void> => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (): Promise<never> =>
      await Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    expect(await openExportFile('suggested.json')).toBeUndefined();
  });

  it('offers the suggested name and a JSON type to the picker', async (): Promise<void> => {
    const asked: unknown[] = [];
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (
      options: unknown,
    ): Promise<never> => {
      asked.push(options);
      return await Promise.reject(new DOMException('closed', 'AbortError'));
    };
    await openExportFile('day0-owner-export-2026-10-13.json');
    expect(asked).toEqual([
      {
        suggestedName: 'day0-owner-export-2026-10-13.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      },
    ]);
  });
});
