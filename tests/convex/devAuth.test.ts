import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  devNoAuthProvider,
  devNoAuthRequested,
  notAuthenticatedMessage,
} from '../../convex/devAuth';

const DATA_JWKS = 'data:text/plain;charset=utf-8;base64,eyJrZXlzIjpbXX0=';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the local issuer', (): void => {
  it('is requested only by the exact string true', (): void => {
    for (const value of ['', '1', 'TRUE', 'yes']) {
      vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', value);
      expect(devNoAuthRequested()).toBe(false);
    }
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    expect(devNoAuthRequested()).toBe(true);
  });

  it('declares a custom JWT provider over the data: key set the key script writes', (): void => {
    vi.stubEnv('DEV_NO_AUTH_JWKS', DATA_JWKS);
    expect(devNoAuthProvider()).toEqual({
      type: 'customJwt',
      applicationID: DEV_NO_AUTH_AUDIENCE,
      issuer: DEV_NO_AUTH_ISSUER,
      jwks: DATA_JWKS,
      algorithm: 'ES256',
    });
  });

  it('accepts a key set served over https', (): void => {
    vi.stubEnv('DEV_NO_AUTH_JWKS', 'https://keys.example.com/jwks.json');
    expect(devNoAuthProvider().jwks).toBe('https://keys.example.com/jwks.json');
  });

  it('refuses a key set fetched over plain http, which anyone on the path could replace', (): void => {
    vi.stubEnv('DEV_NO_AUTH_JWKS', 'http://keys.example.com/jwks.json');
    expect(() => devNoAuthProvider()).toThrow('data: URI or an https:// URL');
  });

  it('refuses the push when no key set is on the deployment', (): void => {
    vi.stubEnv('DEV_NO_AUTH_JWKS', '');
    expect(() => devNoAuthProvider()).toThrow('requires DEV_NO_AUTH_JWKS');
  });

  it('refuses on every hosted-platform marker, the browser-side Vercel one included', (): void => {
    for (const marker of ['VERCEL', 'NEXT_PUBLIC_VERCEL_ENV', 'KUBERNETES_SERVICE_HOST', 'DYNO']) {
      vi.unstubAllEnvs();
      vi.stubEnv('DEV_NO_AUTH_JWKS', DATA_JWKS);
      vi.stubEnv(marker, '1');
      expect(() => devNoAuthProvider()).toThrow(marker);
    }
  });

  it('tells a caller without a local token how to get one only in no-auth mode', (): void => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    expect(notAuthenticatedMessage()).toBe('not authenticated');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    expect(notAuthenticatedMessage()).toContain('unlock URL');
  });
});
