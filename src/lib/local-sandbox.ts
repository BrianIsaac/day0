/// <reference types="node" />
/**
 * Client for the bundled skill-verification sandbox (`pnpm sandbox:up`).
 *
 * The service is a container with no network interface at all, so it is
 * reached over a unix socket on a volume it shares with the Convex backend
 * rather than over a port - see the `sandbox` service in docker-compose.yml
 * and `sandbox/skill_sandbox.py`. That is why this speaks `node:http` over a
 * `socketPath` instead of calling `fetch`.
 *
 * The socket path needs no configuration on the documented route: the compose
 * file mounts the volume at the same place the default names, whether or not
 * the service is running. `SKILL_SANDBOX_SOCKET` is for a backend somewhere
 * else - one running as an ordinary process on this machine, say - and points
 * at wherever that process can see the socket.
 */
import { request as httpRequest } from 'node:http';
import { env } from '../env';
import type { AuthorSkillArgs, SmokeTestOutcome } from './skill-sandbox';

/**
 * Long enough to cover the service's own 60-second cap on a smoke test plus
 * the moment it spends writing files and reading output back. A client that
 * gave up first would report a timeout for a run that was about to answer.
 */
const REQUEST_TIMEOUT_MS = 75_000;

/** Reachability is asked before every run, so it has to be cheap. */
const HEALTH_TIMEOUT_MS = 3_000;

interface SandboxResponse {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function localSandboxSocketPath(): string {
  return env.SKILL_SANDBOX_SOCKET;
}

function call(
  path: string,
  method: 'GET' | 'POST',
  body: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: localSandboxSocketPath(),
        path,
        method,
        // No connection pooling: one request per verification, minutes apart,
        // and a pooled socket to a service that restarts is a dead one.
        agent: false,
        timeout: timeoutMs,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Whether the local sandbox is there to be used.
 *
 * Asked rather than assumed, because the socket outlives a hard stop: a file
 * left behind by a container that is gone answers `ECONNREFUSED`, and treating
 * its presence as availability would turn "the sandbox is not running" into a
 * skill that failed verification.
 */
export async function probeLocalSandbox(): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await call('/health', 'GET', null, HEALTH_TIMEOUT_MS);
    if (res.status !== 200) return { ok: false, reason: `health check answered ${res.status}` };
    return { ok: true, reason: 'serving' };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
}

/**
 * Run one smoke test in the local sandbox.
 *
 * Throws rather than reporting a verdict when the service does not answer at
 * all: the caller has already established that it was there, so a failure here
 * is the sandbox falling over mid-run, which is not the same fact as a smoke
 * test that failed and must not be recorded as one.
 */
export async function runSmokeTestLocally(args: AuthorSkillArgs): Promise<SmokeTestOutcome> {
  const res = await call(
    '/verify',
    'POST',
    JSON.stringify({
      skillName: args.skillName,
      skillBody: args.skillBody,
      smokeTest: args.smokeTest,
    }),
    REQUEST_TIMEOUT_MS,
  );
  if (res.status !== 200) {
    throw new Error(`local sandbox answered ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as SandboxResponse;
  return {
    sandboxId: `local:${parsed.runId}`,
    exitCode: parsed.exitCode,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    timedOut: parsed.timedOut,
  };
}
