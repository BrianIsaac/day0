import { describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import {
  deploymentReleaseLine,
  readDeploymentRelease,
} from '../../../src/setup/deployment-release';

/** 29 September 2026, 13:18:56 UTC: the hosted deployment's v0.8.0 stamp. */
const STAMPED_AT = Date.UTC(2026, 8, 29, 13, 18, 56);

/** 29 September 2026, 19:53:55 UTC: the v0.9.0 stamp, 30 September 03:53 in Singapore. */
const V090_STAMPED_AT = Date.UTC(2026, 8, 29, 19, 53, 55);

describe('the line naming the release the deployment behind a page is stamped at', (): void => {
  it('states the release and the day it was stamped in Singapore, and says so', (): void => {
    expect(deploymentReleaseLine({ release: '0.8.0', since: STAMPED_AT })).toBe(
      'The deployment behind this page has been at v0.8.0 since 29 September 2026, Singapore time.',
    );
  });

  it('dates a stamp taken before midnight UTC by the Singapore day it already was (C1)', (): void => {
    expect(deploymentReleaseLine({ release: '0.9.0', since: V090_STAMPED_AT })).toBe(
      'The deployment behind this page has been at v0.9.0 since 30 September 2026, Singapore time.',
    );
  });

  it('dates the last Singapore minute of a day by that day, and the next minute by the next', (): void => {
    const lastMinute = Date.UTC(2026, 8, 29, 15, 59);
    const nextMinute = Date.UTC(2026, 8, 29, 16, 0);
    expect(deploymentReleaseLine({ release: '0.9.0', since: lastMinute })).toContain(
      'since 29 September 2026, Singapore time.',
    );
    expect(deploymentReleaseLine({ release: '0.9.0', since: nextMinute })).toContain(
      'since 30 September 2026, Singapore time.',
    );
  });

  it('dates a stamp taken after midnight UTC by the same Singapore day', (): void => {
    expect(
      deploymentReleaseLine({ release: '0.9.0', since: Date.UTC(2026, 8, 30, 0, 30) }),
    ).toContain('since 30 September 2026, Singapore time.');
  });
});

describe('reading the stamp', (): void => {
  it('asks the deployment named by the environment and returns its newest stamp', async (): Promise<void> => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            status: 'success',
            value: { release: '0.8.0', since: STAMPED_AT },
            logLines: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      readDeploymentRelease(
        api.config.release,
        { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' },
        fetch,
      ),
    ).resolves.toEqual({ release: '0.8.0', since: STAMPED_AT });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^http:\/\/127\.0\.0\.1:3210\/api\/query/);
    // The query is the one the caller passed in, so `src/` names no Convex function itself (m25).
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      path: 'config:release',
    });
    const elsewhere = makeFunctionReference<
      'query',
      Record<string, never>,
      { release: string; since: number } | null
    >('releases:stamped');
    await readDeploymentRelease(
      elsewhere,
      { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' },
      fetch,
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      path: 'releases:stamped',
    });
  });

  it('returns nothing, without a request, when no deployment is named', async (): Promise<void> => {
    const fetch = vi.fn();
    await expect(readDeploymentRelease(api.config.release, {}, fetch)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns nothing when the deployment has no stamp, or cannot be asked', async (): Promise<void> => {
    const answer = (value: unknown) =>
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ status: 'success', value, logLines: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
    const env = { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' };
    await expect(readDeploymentRelease(api.config.release, env, answer(null))).resolves.toBeNull();
    const refused = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const printed = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    await expect(readDeploymentRelease(api.config.release, env, refused)).resolves.toBeNull();
    printed.mockRestore();
  });

  it('returns nothing when the deployment answers with a server error or a body that is not JSON (review m21)', async (): Promise<void> => {
    const env = { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' };
    const printed = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    try {
      const badGateway = vi.fn(
        async (): Promise<Response> =>
          new Response('<html>Bad Gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      );
      await expect(readDeploymentRelease(api.config.release, env, badGateway)).resolves.toBeNull();
      const malformed = vi.fn(
        async (): Promise<Response> =>
          new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      await expect(readDeploymentRelease(api.config.release, env, malformed)).resolves.toBeNull();
    } finally {
      printed.mockRestore();
    }
  });
});
