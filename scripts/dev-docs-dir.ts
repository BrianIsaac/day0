/// <reference types="node" />
/**
 * Runs before `docker compose up` so the documentation bind mount has a
 * directory: Compose refuses to create it (Docker would make it root-owned)
 * and a clean clone does not carry the gitignored default.
 *
 *   pnpm convex:up      runs this first
 */
import { existsSync, readFileSync } from 'node:fs';
import { ensureDocsHostDir } from '../src/docs/host-dir';

const ENV_FILE = '.env.local';
const DOCS_HOST_DIR_VAR = 'DAY0_DOCS_HOST_DIR';

/**
 * Read one variable the way Compose does: `.env.local`, then the process.
 *
 * Args:
 *   name: Environment variable name.
 *
 * Returns:
 *   The configured value, or undefined when neither source sets it.
 */
function readSetting(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === name) return match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

try {
  const result = ensureDocsHostDir(readSetting(DOCS_HOST_DIR_VAR), process.cwd());
  if (result.created) {
    console.log(
      `Created an empty documentation directory at ${result.path} for the backend's read-only ` +
        'mount. Mock mode never reads it; real mode links folders below it.',
    );
  }
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
