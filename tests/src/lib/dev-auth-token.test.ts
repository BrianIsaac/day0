import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SUBJECT,
} from '../../../src/lib/dev-auth-issuer';
import { localManagerAddress, mintDevNoAuthToken } from '../../../src/lib/dev-auth-token';

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A fresh P-256 keypair, the private half base64 PKCS#8 as the env file stores it. */
async function keypair(): Promise<{ encodedPrivate: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    encodedPrivate: Buffer.from(pkcs8).toString('base64'),
    publicKey: pair.publicKey,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('mintDevNoAuthToken', (): void => {
  it('signs the issuer claims with the key it is given, so a script needs no environment', async (): Promise<void> => {
    const { encodedPrivate, publicKey } = await keypair();
    const token = await mintDevNoAuthToken('session-7', encodedPrivate);
    const [header, payload, signature] = token.split('.');
    expect(decodeSegment(header!)).toEqual({
      alg: DEV_NO_AUTH_ALGORITHM,
      typ: 'JWT',
      kid: DEV_NO_AUTH_KEY_ID,
    });
    const claims = decodeSegment(payload!);
    expect(claims).toMatchObject({
      sub: DEV_NO_AUTH_SUBJECT,
      iss: DEV_NO_AUTH_ISSUER,
      aud: DEV_NO_AUTH_AUDIENCE,
      sid: 'session-7',
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signature!, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  it('carries no session claim when no session is named', async (): Promise<void> => {
    const { encodedPrivate } = await keypair();
    const claims = decodeSegment(
      (await mintDevNoAuthToken(undefined, encodedPrivate)).split('.')[1]!,
    );
    expect(claims).not.toHaveProperty('sid');
  });

  it('says which variable to set when no key is available', async (): Promise<void> => {
    await expect(mintDevNoAuthToken('s', undefined)).rejects.toThrow(
      'DEV_NO_AUTH_SIGNING_KEY is not set',
    );
  });
});

describe('the local manager address', (): void => {
  it('is the configured address, trimmed and lower-cased', (): void => {
    expect(localManagerAddress({ NEXT_PUBLIC_DEMO_BOSS_EMAIL: ' Manager@Example.com ' })).toBe(
      'manager@example.com',
    );
  });

  it('is the local default when none is configured', (): void => {
    expect(localManagerAddress({})).toBe('boss@day0.local');
    expect(localManagerAddress({ NEXT_PUBLIC_DEMO_BOSS_EMAIL: '  ' })).toBe('boss@day0.local');
  });

  it('refuses a configured value that is not an address, naming the variable and not the value', (): void => {
    expect(() => localManagerAddress({ NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss at work' })).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('NEXT_PUBLIC_DEMO_BOSS_EMAIL'),
      }),
    );
    expect(() => localManagerAddress({ NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss at work' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('boss at work') }),
    );
  });
});

describe("the local token's address", (): void => {
  it('carries the manager address it is given as a verified email', async (): Promise<void> => {
    const { encodedPrivate } = await keypair();
    const claims = decodeSegment(
      (await mintDevNoAuthToken('s', encodedPrivate, 'lead@day0.local')).split('.')[1]!,
    );
    expect(claims).toMatchObject({ email: 'lead@day0.local', email_verified: true });
  });

  it('carries the configured manager address when none is given, as a script minting with no environment but the key', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_BOSS_EMAIL', 'Ops@Kestrel.Example');
    const { encodedPrivate } = await keypair();
    const claims = decodeSegment(
      (await mintDevNoAuthToken(undefined, encodedPrivate)).split('.')[1]!,
    );
    expect(claims).toMatchObject({ email: 'ops@kestrel.example', email_verified: true });
  });
});
