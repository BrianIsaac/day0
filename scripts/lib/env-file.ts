/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { upsertEnvText } from '../demo-bed';
import { writePrivateEnv } from '../private-env';
import { readEnvFileValues } from './env-text';

/**
 * Reading and writing the env file a setup verb keeps its values in, shared by
 * the setup and the sign-in verb and its check.
 */

/**
 * Every `KEY=value` an env file declares, as dotenv reads it (`readEnvFileValues`, W17-R24).
 *
 * Args:
 *   path: Env file path.
 *
 * Returns:
 *   The declared values; empty when the file does not exist.
 */
export function readEnvValues(path: string): Record<string, string> {
  return readEnvFileValues(path);
}

/**
 * Write values into an env file without disturbing anything else in it.
 *
 * The file holds a provider key, a credential key and an admin key, so it is
 * written through a temporary file in the same directory and renamed over the
 * original: a reader who interrupts this never ends up with half a file. The
 * mode is set before the rename, so the key is never briefly world-readable.
 *
 * Args:
 *   path: Env file path, which must already exist.
 *   updates: Names and values to replace or append.
 */
export function writeEnvValues(path: string, updates: Readonly<Record<string, string>>): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writePrivateEnv(path, upsertEnvText(text, updates));
}
