import { describe, expect, it } from 'vitest';
import {
  COOKIE_CHUNK_LENGTH,
  chunkCookie,
  cookieNames,
  joinCookie,
  openSession,
  openTransaction,
  seal,
  sealSession,
  sealTransaction,
  sessionSecretGap,
  unseal,
  type CustomerSession,
} from '../../../src/lib/customer-session';

const SECRET = 'k'.repeat(43);
const OTHER = 'o'.repeat(43);
const NOW = 1_790_000_000_000;

const SESSION: CustomerSession = {
  version: 1,
  idToken: 'header.payload.signature',
  idTokenExpiresAt: NOW + 120_000,
  refreshToken: 'refresh-token',
  startedAt: NOW,
  expiresAt: NOW + 3_600_000,
};

describe('the customer session', (): void => {
  it('a sealed session opens with its key and not with another', async (): Promise<void> => {
    const sealed = await sealSession(SECRET, SESSION);
    expect(await openSession(SECRET, sealed, NOW)).toEqual(SESSION);
    expect(await openSession(OTHER, sealed, NOW)).toBeUndefined();
  });

  it('carries nothing a reader of the cookie can see', async (): Promise<void> => {
    const sealed = await sealSession(SECRET, SESSION);
    expect(sealed).not.toContain('refresh-token');
    expect(Buffer.from(sealed.split('.')[2], 'base64url').toString('latin1')).not.toContain(
      'refresh-token',
    );
  });

  it('does not open once a byte is changed', async (): Promise<void> => {
    const sealed = await sealSession(SECRET, SESSION);
    const [version, iv, body] = sealed.split('.');
    const flipped = `${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}`;
    expect(await openSession(SECRET, `${version}.${iv}.${flipped}`, NOW)).toBeUndefined();
  });

  it('does not open past its absolute end, though an expired ID token still opens', async (): Promise<void> => {
    const sealed = await sealSession(SECRET, SESSION);
    expect(await openSession(SECRET, sealed, SESSION.idTokenExpiresAt + 1)).toBeDefined();
    expect(await openSession(SECRET, sealed, SESSION.expiresAt)).toBeUndefined();
  });

  it('keeps a transaction and a session apart: neither opens as the other', async (): Promise<void> => {
    const transaction = await sealTransaction(SECRET, {
      version: 1,
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/',
      expiresAt: NOW + 600_000,
    });
    expect(await openSession(SECRET, transaction, NOW)).toBeUndefined();
    expect(await openTransaction(SECRET, await sealSession(SECRET, SESSION), NOW)).toBeUndefined();
    expect(await openTransaction(SECRET, transaction, NOW)).toMatchObject({ state: 's' });
  });

  it('opens nothing from a malformed value, and nothing with an unusable secret', async (): Promise<void> => {
    for (const value of [undefined, '', 'v1', 'v1.a.b', 'v2.AAAAAAAAAAAAAAAA.AAAA', 'v1.!!!.???']) {
      expect(await unseal(SECRET, 'session', value)).toBeUndefined();
    }
    const sealed = await seal(SECRET, 'session', SESSION);
    expect(await unseal('short', 'session', sealed)).toBeUndefined();
    await expect(seal('short', 'session', SESSION)).rejects.toThrow('at least 43');
  });

  it('says what is wrong with a secret', (): void => {
    expect(sessionSecretGap(undefined)).toBe('DAY0_SESSION_SECRET is not set.');
    expect(sessionSecretGap('x'.repeat(42))).toContain('42 characters');
    expect(sessionSecretGap(SECRET)).toBeUndefined();
  });
});

describe('a session longer than one cookie', (): void => {
  it('is split into numbered cookies and joined back in order', (): void => {
    const value = 'a'.repeat(COOKIE_CHUNK_LENGTH) + 'b'.repeat(COOKIE_CHUNK_LENGTH) + 'c';
    const chunks = chunkCookie('day0_session', value);
    expect(chunks.map((chunk) => chunk.name)).toEqual([
      'day0_session.0',
      'day0_session.1',
      'day0_session.2',
    ]);
    const jar = new Map(chunks.map((chunk) => [chunk.name, chunk.value]));
    expect(joinCookie('day0_session', (name) => jar.get(name))).toBe(value);
  });

  it('stays one cookie when it fits, and every name it may use is known', (): void => {
    expect(chunkCookie('day0_session', 'short')).toEqual([
      { name: 'day0_session', value: 'short' },
    ]);
    expect(cookieNames('day0_session')).toContain('day0_session.5');
  });

  it('is refused rather than cut when it would need more than six cookies', (): void => {
    expect(() => chunkCookie('day0_session', 'x'.repeat(COOKIE_CHUNK_LENGTH * 6 + 1))).toThrow(
      'past what 6 cookies carry',
    );
  });
});
