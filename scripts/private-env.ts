import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

/** Publish complete secret files without following or reusing a temporary path. */
export function writePrivateEnv(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
