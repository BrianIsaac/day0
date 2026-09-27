import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

describe('next.config.mjs', (): void => {
  it('draws no development badge: the recording is taken from `next dev`, and the badge was in every frame', (): void => {
    expect(nextConfig.devIndicators).toBe(false);
  });
});

describe('the security headers', (): void => {
  /** The headers every path is served with. */
  async function headersForEveryPath(): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const everyPath = rules.find((rule) => rule.source === '/:path*');
    return Object.fromEntries((everyPath?.headers ?? []).map(({ key, value }) => [key, value]));
  }

  it('refuses to be framed by any page, in both the old header and the policy', async (): Promise<void> => {
    const headers = await headersForEveryPath();
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'none'");
  });

  it('stops content sniffing and keeps paths and queries out of cross-origin referrers', async (): Promise<void> => {
    const headers = await headersForEveryPath();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('allows the microphone to the app itself, which the voice 1:1 needs, and nothing else', async (): Promise<void> => {
    expect((await headersForEveryPath())['Permissions-Policy']).toBe(
      'camera=(), geolocation=(), microphone=(self)',
    );
  });
});
