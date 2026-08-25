import { existsSync, mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCS_HOST_DIR, ensureDocsHostDir } from '../../../src/docs/host-dir';

describe('documentation host directory', (): void => {
  it('creates the default directory once, user-owned, when a clean clone lacks it', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'day0-docs-dir-'));
    const first = ensureDocsHostDir(undefined, cwd);
    expect(first).toEqual({ path: join(cwd, 'docs-local'), created: true });
    expect(existsSync(first.path)).toBe(true);
    expect(statSync(first.path).uid).toBe(process.getuid?.() ?? statSync(first.path).uid);
    expect(ensureDocsHostDir(DEFAULT_DOCS_HOST_DIR, cwd)).toEqual({
      path: first.path,
      created: false,
    });
    expect(ensureDocsHostDir('  ', cwd)).toEqual({ path: first.path, created: false });
  });

  it('accepts an existing operator path and refuses to invent a missing one', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'day0-docs-dir-'));
    const custom = join(cwd, 'handbook');
    expect(() => ensureDocsHostDir(custom, cwd)).toThrow('does not exist');
    expect(existsSync(custom)).toBe(false);
    mkdirSync(custom);
    expect(ensureDocsHostDir(custom, cwd)).toEqual({ path: custom, created: false });
    expect(ensureDocsHostDir('./handbook', cwd)).toEqual({ path: custom, created: false });
  });
});
