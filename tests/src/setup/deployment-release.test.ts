import { describe, expect, it, vi } from 'vitest';
import {
  deploymentReleaseLine,
  readDeploymentRelease,
} from '../../../src/setup/deployment-release';

/** 29 September 2026, 13:18:56 UTC: the hosted deployment's v0.8.0 stamp. */
const STAMPED_AT = Date.UTC(2026, 8, 29, 13, 18, 56);

describe('the line naming the release the deployment behind a page is stamped at', (): void => {
  it('states the release and the day it was stamped, as a dated fact', (): void => {
    expect(deploymentReleaseLine({ release: '0.8.0', since: STAMPED_AT })).toBe(
      'The deployment behind this page has been at v0.8.0 since 29 September 2026.',
    );
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
      readDeploymentRelease({ NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' }, fetch),
    ).resolves.toEqual({ release: '0.8.0', since: STAMPED_AT });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^http:\/\/127\.0\.0\.1:3210\/api\/query/);
  });

  it('returns nothing, without a request, when no deployment is named', async (): Promise<void> => {
    const fetch = vi.fn();
    await expect(readDeploymentRelease({}, fetch)).resolves.toBeNull();
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
    await expect(readDeploymentRelease(env, answer(null))).resolves.toBeNull();
    const refused = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const printed = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    await expect(readDeploymentRelease(env, refused)).resolves.toBeNull();
    printed.mockRestore();
  });
});
