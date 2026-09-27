import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * A maker of temporary directories that are removed after each test.
 *
 * Call it once at the top level of a test file; it registers the `afterEach`
 * that removes every directory made since, so a test leaves nothing behind in
 * the machine's temp directory (standard 11.4).
 *
 * @returns A function that makes one directory under the OS temp directory
 *   with the given prefix and returns its path.
 */
export function temporaryDirectories(): (prefix: string) => string {
  const made: string[] = [];
  afterEach((): void => {
    for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  return (prefix: string): string => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    made.push(directory);
    return directory;
  };
}
