import { describe, expect, it } from 'vitest';
import { must, runCommand, startServer, waitUntil } from '../../../scripts/rehearsal/process';

describe('the process adapter', (): void => {
  it('runs a command to completion with both streams captured', (): void => {
    const result = runCommand('sh', ['-c', 'echo out; echo err >&2; exit 3']);
    expect(result).toEqual({ status: 3, stdout: 'out\n', stderr: 'err\n' });
    expect(() => must(result, 'sh')).toThrow('sh failed (status 3).\nout\nerr\n');
    expect(must(runCommand('sh', ['-c', 'true']), 'true').status).toBe(0);
  });

  it('starts a server child, keeps its output, and stops it by its own pid', async (): Promise<void> => {
    const server = startServer('sh', ['-c', 'echo ready; sleep 30'], {});
    expect(server.pid).toBeGreaterThan(0);
    await waitUntil(async () => server.output().includes('ready') || undefined, {
      what: 'the child to print',
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    await server.stop();
    expect(runCommand('sh', ['-c', `kill -0 ${server.pid}`]).status).not.toBe(0);
    await server.stop();
  });

  it('waits until the probe answers and names the wait when the ceiling passes', async (): Promise<void> => {
    let clock = 0;
    const now = (): number => clock;
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };
    let calls = 0;
    const value = await waitUntil(
      async () => {
        calls += 1;
        return calls === 3 ? 'seen' : undefined;
      },
      { what: 'three calls', timeoutMs: 10_000, intervalMs: 1_000, sleep, now },
    );
    expect(value).toBe('seen');
    expect(clock).toBe(2_000);
    await expect(
      waitUntil(async () => false, { what: 'never', timeoutMs: 3_000, intervalMs: 1_000, sleep, now }),
    ).rejects.toThrow('timed out after 3 s waiting for never.');
  });
});
