import { spawnSync } from 'node:child_process';

/**
 * Whether a command-line tool a test spawns is on this machine's PATH.
 *
 * The gate runs on machines that differ in what they install, so a test that
 * needs `python3`, `bash`, `curl`, `zip`, `unzip` or `sha256sum` skips, with
 * the tool in its name, rather than failing for a reason unrelated to the code
 * (standard 11.4; CONTRIBUTING lists the tools).
 */
export function hasHostTool(tool: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
}

/** Whether every one of the tools is on the PATH. */
export function hasHostTools(...tools: readonly string[]): boolean {
  return tools.every(hasHostTool);
}
