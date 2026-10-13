/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { restartEnvironment } from './proxy-env';

/**
 * Start this command again under the proxy its env file names, when it was started without it
 * (wave 17, 17-P; RM31 (a)): Node reads a proxy from its environment only at its start, so a
 * command that finds one in the file cannot take it up where it stands. The second start has the
 * same Node, loader, script and arguments, the terminal, and the proxy with this machine's own
 * names kept out of it, which its children inherit.
 *
 * @param file - The env file's values.
 * @returns The restarted command's exit status, or undefined when this process is the one to run.
 */
export function runUnderProxy(
  file: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const wanted = restartEnvironment(process.env, file);
  if (wanted === undefined) return undefined;
  const again = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, ...wanted },
  });
  if (again.error !== undefined) {
    console.error(`error: this command could not be started again (${again.error.message}).`);
  }
  return again.status ?? 1;
}
