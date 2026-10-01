import { describe, expect, it } from 'vitest';
import { serverConvexUrl } from '../../../src/lib/convex-url';

describe('the server-side Convex address', (): void => {
  it('prefers CONVEX_URL, the address a server process reaches the backend on', (): void => {
    expect(
      serverConvexUrl({
        CONVEX_URL: ' http://backend:3210 ',
        NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
      }),
    ).toBe('http://backend:3210');
  });

  it("falls back to the browser's address", (): void => {
    expect(
      serverConvexUrl({ CONVEX_URL: '', NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' }),
    ).toBe('http://127.0.0.1:3210');
  });

  it('refuses when neither is set', (): void => {
    expect(() => serverConvexUrl({})).toThrow('CONVEX_URL');
  });
});
