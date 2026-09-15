/**
 * The rehearsal's process adapter: one synchronous runner for the commands
 * that finish, one child for the app server that does not, both injectable
 * so the phases are testable without a shell.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** Runs one command to completion. */
export type Runner = (command: string, args: readonly string[], options?: RunOptions) => RunResult;

/**
 * Run a command to completion with its output captured.
 *
 * Args:
 *   command: The executable.
 *   args: Its arguments.
 *   options: Working directory, extra environment, and a ceiling.
 *
 * Returns:
 *   Exit status and both streams.
 */
export const runCommand: Runner = (command, args, options = {}) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * Insist a command succeeded.
 *
 * Args:
 *   result: What it returned.
 *   what: The command, for the message.
 *
 * Returns:
 *   The same result.
 *
 * Raises:
 *   Error: With both streams when the status is not zero.
 */
export function must(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    throw new Error(`${what} failed (status ${result.status}).\n${result.stdout}${result.stderr}`);
  }
  return result;
}

export interface ServerHandle {
  pid: number;
  /** Everything the server wrote so far, for the record. */
  output: () => string;
  /** Stop the server by its own pid, never by a pattern. */
  stop: () => Promise<void>;
}

/** Starts a long-running child and hands back its handle. */
export type ServerStarter = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => ServerHandle;

/**
 * Start a server child whose lifetime is the run's.
 *
 * The child is stopped by its single pid with SIGTERM and then SIGKILL,
 * because a pattern sweep once killed another session's server.
 *
 * Args:
 *   command: The executable.
 *   args: Its arguments.
 *   options: Working directory and extra environment.
 *
 * Returns:
 *   The handle.
 */
export const startServer: ServerStarter = (command, args, options) => {
  const child: ChildProcess = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const exited = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
  });
  return {
    pid: child.pid ?? -1,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
};

/**
 * Wait until a probe answers true.
 *
 * Args:
 *   probe: The condition.
 *   options: Ceiling, interval, what is being waited for, and injectable sleep.
 *
 * Returns:
 *   The probe's last value.
 *
 * Raises:
 *   Error: Naming the wait when the ceiling passes first.
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined | false>,
  options: {
    what: string;
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const interval = options.intervalMs ?? 2_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (now() >= deadline) {
      throw new Error(`timed out after ${options.timeoutMs / 1000} s waiting for ${options.what}.`);
    }
    await sleep(interval);
  }
}
