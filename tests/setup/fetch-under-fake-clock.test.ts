import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../vitest.config';
import {
  FETCH_GUARD_SETUP_FILE,
  FetchUnderFakeClockError,
  refuseFetchUnderFakeClock,
  refusedFetchFailure,
} from './fetch-under-fake-clock';

/** The repository root, found from this file rather than the working directory. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The nested run's configuration: the guard alone, in both of the suite's environments. */
const NESTED_CONFIG = 'tests/fixtures/fake-clock-fetch/vitest.config.ts';

/** The part of vitest's JSON report the nested run is judged on. */
interface NestedReport {
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly assertionResults: ReadonlyArray<{
      readonly title: string;
      readonly status: string;
      readonly duration?: number;
      readonly failureMessages: readonly string[];
    }>;
  }>;
}

/** A `fetch` that answers every request itself and records what it was asked, `init` included. */
function answeringFetch(): {
  readonly fetch: typeof fetch;
  readonly asked: string[];
  readonly inits: Array<RequestInit | undefined>;
} {
  const asked: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  return {
    asked,
    inits,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      asked.push(input instanceof Request ? input.url : String(input));
      inits.push(init);
      return new Response('answered');
    },
  };
}

afterEach((): void => {
  vi.useRealTimers();
});

describe('fetch under a faked clock', (): void => {
  it('refuses a request while setTimeout is faked, before the transport sees it, and reports its address', async (): Promise<void> => {
    const transport = answeringFetch();
    const reported: string[] = [];
    const guarded = refuseFetchUnderFakeClock(transport.fetch, (address): void => {
      reported.push(address);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const refusal = guarded(new URL('http://double.test:8000/v1/spans'), { method: 'POST' });

    await expect(refusal).rejects.toBeInstanceOf(FetchUnderFakeClockError);
    await expect(refusal).rejects.toThrow('http://double.test:8000/v1/spans');
    expect(transport.asked).toEqual([]);
    expect(reported).toEqual(['http://double.test:8000/v1/spans']);
  });

  it('reports a Request by its address as well as a string or a URL', async (): Promise<void> => {
    const reported: string[] = [];
    const guarded = refuseFetchUnderFakeClock(answeringFetch().fetch, (address): void => {
      reported.push(address);
    });
    vi.useFakeTimers();

    const outcomes = await Promise.allSettled([
      guarded('http://one.test/a'),
      guarded(new URL('http://two.test/b')),
      guarded(new Request('http://three.test/c', { method: 'POST', body: 'x' })),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(reported).toEqual(['http://one.test/a', 'http://two.test/b', 'http://three.test/c']);
  });

  it('hands a request to the transport untouched while setTimeout is real', async (): Promise<void> => {
    const transport = answeringFetch();
    const reported: string[] = [];
    const guarded = refuseFetchUnderFakeClock(transport.fetch, (address): void => {
      reported.push(address);
    });

    const init: RequestInit = { method: 'POST', body: '{}', headers: { 'x-probe': '1' } };

    const response = await guarded('http://double.test:8000/healthz', init);

    expect(await response.text()).toBe('answered');
    expect(transport.asked).toEqual(['http://double.test:8000/healthz']);
    expect(transport.inits).toEqual([init]);
    expect(transport.inits[0]).toBe(init);
    expect(reported).toEqual([]);
  });

  it('lets a request through when only Date is faked, since the transport arms no faked timer', async (): Promise<void> => {
    const transport = answeringFetch();
    const guarded = refuseFetchUnderFakeClock(transport.fetch, (): void => {
      throw new Error('nothing is refused under a Date-only fake');
    });
    vi.useFakeTimers({ toFake: ['Date'] });

    await expect(guarded('http://double.test:8000/healthz')).resolves.toBeInstanceOf(Response);
    expect(transport.asked).toEqual(['http://double.test:8000/healthz']);
  });

  it('names a refused request by its origin and path, never its query or credentials', async (): Promise<void> => {
    const reported: string[] = [];
    const guarded = refuseFetchUnderFakeClock(answeringFetch().fetch, (address): void => {
      reported.push(address);
    });
    vi.useFakeTimers();

    const refusal = guarded('http://operator:hunter2@double.test:8000/v1/spans?token=abc123');

    await expect(refusal).rejects.toThrow('http://double.test:8000/v1/spans refused');
    await expect(refusal).rejects.not.toThrow(/hunter2|abc123/);
    expect(reported).toEqual(['http://double.test:8000/v1/spans']);
  });

  it('fails a test that made refused requests, naming each address once', (): void => {
    expect(refusedFetchFailure([])).toBeUndefined();
    const failure = refusedFetchFailure([
      'http://double.test:8000/v1/spans',
      'http://double.test:8000/v1/spans',
      'http://other.test/',
    ]);
    expect(failure).toBeInstanceOf(FetchUnderFakeClockError);
    expect(failure?.message).toContain('3 requests');
    expect(failure?.message).toContain('http://double.test:8000/v1/spans, http://other.test/');
  });

  it('is a setup file of every project the suite runs', (): void => {
    const projects = config.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    const setupFiles = projects.map((project): unknown =>
      typeof project === 'object' && 'test' in project ? project.test?.setupFiles : undefined,
    );
    for (const files of setupFiles) expect(files).toContain(FETCH_GUARD_SETUP_FILE);
  });

  it('fails a test that swallows the refusal, in both environments, without waiting on the clock', (): void => {
    // A nested run, so the failure is the runner's own verdict on a test, not this file's.
    const reportDir = mkdtempSync(join(tmpdir(), 'fake-clock-fetch-'));
    const reportFile = join(reportDir, 'report.json');
    try {
      const run = spawnSync(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          NESTED_CONFIG,
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${reportFile}`,
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
      );
      expect(run.status, run.stdout + run.stderr).toBe(1);
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as NestedReport;
      const results = report.testResults.flatMap((file) =>
        file.assertionResults.map((test) => ({ file: relative(ROOT, file.name), ...test })),
      );
      const swallowed = results.filter((test) => test.title.startsWith('swallows'));
      const quiet = results.filter((test) => test.title.startsWith('fetches nothing'));
      const passedThrough = results.filter((test) =>
        test.title.startsWith('reaches the transport'),
      );
      expect(swallowed).toHaveLength(2);
      expect(quiet).toHaveLength(2);
      expect(passedThrough).toHaveLength(2);
      for (const test of swallowed) {
        expect(test.status).toBe('failed');
        expect(test.failureMessages.join('\n')).toContain('http://double.test:8000/v1/spans');
        // Under the nested run's 5 s test timeout: a stall would end there, a refusal in milliseconds.
        expect(test.duration ?? Number.POSITIVE_INFINITY).toBeLessThan(3_000);
      }
      for (const test of [...quiet, ...passedThrough]) expect(test.status).toBe('passed');
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});
