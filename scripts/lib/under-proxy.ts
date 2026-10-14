/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { QUIET_PROXY_WARNING, restartEnvironment } from './proxy-env';

/**
 * Start this command again under the proxy its env file names, when it was started without it
 * (wave 17, 17-P; RM31 (a)), or with a proxy the shell names and the file does not (wave 18,
 * D-9 (a)): Node reads a proxy from its environment only at its start, so a command that finds
 * one in the file cannot take it up where it stands, nor put down one the shell gave it. The
 * second start has the same Node, loader, script and arguments, the terminal, the environment
 * `restartEnvironment` gives whole (never merged over the shell's, which would hand the shell's
 * proxy back), and the flag that quiets Node's proxy warning, which its children inherit.
 *
 * @param file - The env file's values.
 * @returns The restarted command's exit status, or undefined when this process is the one to run.
 */
export function runUnderProxy(
  file: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const wanted = restartEnvironment(process.env, file);
  if (wanted === undefined) return undefined;
  const again = spawnSync(process.execPath, restartArguments(wanted), {
    stdio: 'inherit',
    env: wanted as NodeJS.ProcessEnv,
  });
  if (again.error !== undefined) {
    console.error(`error: this command could not be started again (${again.error.message}).`);
  }
  return again.status ?? 1;
}

/**
 * The second start's arguments: this process's own, with the flag that quiets Node's proxy
 * warning where the proxy is switched on and the flag is not already given (W17-R28).
 *
 * @param wanted - The environment the command starts again with.
 */
export function restartArguments(wanted: Readonly<Record<string, string>>): string[] {
  const quiet =
    wanted.NODE_USE_ENV_PROXY === '1' && !process.execArgv.includes(QUIET_PROXY_WARNING)
      ? [QUIET_PROXY_WARNING]
      : [];
  return [...quiet, ...process.execArgv, ...process.argv.slice(1)];
}
