import { describe, expect, it } from 'vitest';
import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SUBJECT,
} from '../../../src/lib/dev-auth-issuer';
import { mintDevNoAuthToken } from '../../../src/lib/dev-auth-token';

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
