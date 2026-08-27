import { describe, expect, it } from 'vitest';
import {
  newOauthNonce,
  OAUTH_STATE_TTL_MS,
  signOauthState,
  verifyOauthState,
} from '../../../src/lib/oauth-state';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const NOW = 1_787_800_000_000;

function state(overrides: Partial<{ expiresAt: number; nonce: string; surfaceId: string }> = {}) {
  return signOauthState(
    {
      expiresAt: overrides.expiresAt ?? NOW + OAUTH_STATE_TTL_MS,
      nonce: overrides.nonce ?? 'nonce-value',
      surfaceId: overrides.surfaceId ?? 'kx7surface',
    },
    KEY,
  );
}

describe('the install link state', (): void => {
  it('round-trips the surface and nonce it was minted for', (): void => {
    const verified = verifyOauthState(state(), KEY, NOW);
    expect(verified).toEqual({
      ok: true,
      expiresAt: NOW + OAUTH_STATE_TTL_MS,
      nonce: 'nonce-value',
      surfaceId: 'kx7surface',
    });
  });

  it('refuses a state signed with another deployment\'s key', (): void => {
    expect(verifyOauthState(state(), OTHER_KEY, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a state whose surface was swapped after signing', (): void => {
    const parts = state().split('.');
    parts[1] = 'kx7another';
    expect(verifyOauthState(parts.join('.'), KEY, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a state whose expiry was pushed out after signing', (): void => {
    const parts = signOauthState(
      { expiresAt: NOW - 1, nonce: 'nonce-value', surfaceId: 'kx7surface' },
      KEY,
    ).split('.');
    parts[3] = String(NOW + OAUTH_STATE_TTL_MS);
    expect(verifyOauthState(parts.join('.'), KEY, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses an expired link on its own expiry millisecond', (): void => {
    const expiring = state({ expiresAt: NOW });
    expect(verifyOauthState(expiring, KEY, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyOauthState(expiring, KEY, NOW - 1)).toMatchObject({ ok: true });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['the wrong shape', 'v1.surface.nonce'],
    ['a future version', 'v2.surface.nonce.1.sig'],
    ['a non-numeric expiry', 'v1.surface.nonce.soon.sig'],
    ['an empty nonce', 'v1.surface..1.sig'],
  ])('refuses a state that is %s', (_label, value): void => {
    expect(verifyOauthState(value, KEY, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to sign or verify without a credential key', (): void => {
    expect(() => signOauthState({ expiresAt: NOW, nonce: 'n', surfaceId: 's' }, undefined)).toThrow(
      'DAY0_CREDENTIAL_KEY',
    );
    expect(() => verifyOauthState(state(), undefined, NOW)).toThrow('DAY0_CREDENTIAL_KEY');
  });

  it('does not put the nonce or the key in the signature segment', (): void => {
    const token = state();
    const signature = token.split('.')[4];
    expect(signature).not.toContain('nonce-value');
    expect(signature).not.toContain(KEY);
  });

  it('mints a fresh nonce every time', (): void => {
    const nonces = new Set(Array.from({ length: 50 }, (): string => newOauthNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
