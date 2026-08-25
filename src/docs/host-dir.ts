import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** The Compose default for the read-only documentation bind mount. */
export const DEFAULT_DOCS_HOST_DIR = './docs-local';

export interface DocsHostDir {
  path: string;
  created: boolean;
}

/**
 * Make sure the documentation bind mount has a host directory to point at.
 *
 * The directory is gitignored, so a clean clone has none, and Compose is
 * told never to create it (Docker would create it root-owned). Mock mode
 * never reads it, so the default location is created empty and user-owned;
 * any other configured path is the operator's and must already exist,
 * because silently creating it would hide a typo as "0 pages".
 *
 * Args:
 *   configured: `DAY0_DOCS_HOST_DIR` as written in the environment.
 *   cwd: Repository root the Compose file resolves relative paths from.
 *
 * Returns:
 *   The absolute directory and whether it was created now.
 *
 * Raises:
 *   Error: If a non-default path does not exist.
 */
export function ensureDocsHostDir(configured: string | undefined, cwd: string): DocsHostDir {
  const value = configured?.trim() || DEFAULT_DOCS_HOST_DIR;
  const path = resolve(cwd, value);
  if (existsSync(path)) return { path, created: false };
  if (path !== resolve(cwd, DEFAULT_DOCS_HOST_DIR)) {
    throw new Error(
      `DAY0_DOCS_HOST_DIR=${value} does not exist. Create it, or point it at the directory ` +
        'holding the Markdown the backend should read.',
    );
  }
  mkdirSync(path, { recursive: true });
  return { path, created: true };
}
