import { describe, expect, it, vi } from 'vitest';
import { READER_TOKEN_MARGIN_MS, readerTokenServes } from '../../../../src/docs/readers/batch';
import {
  BatchToken,
  issuedToken,
  type IssuedToken,
} from '../../../../src/docs/readers/reader-token';

/** 14 October 2026, 09:00 UTC. */
const T0 = Date.UTC(2026, 9, 14, 9, 0, 0);

/** A provider's sign-in that counts how often it was asked. */
function provider(issued: IssuedToken): { ask: () => Promise<IssuedToken>; asked: () => number } {
  let asked = 0;
  return {
    ask: async (): Promise<IssuedToken> => {
      asked += 1;
      return issued;
    },
    asked: (): number => asked,
  };
}

/** A batch's token opened at T0 with what the sync handed in. */
async function opened(
  handed: { token: string; expiresAt: number } | undefined,
  sign: { ask: () => Promise<IssuedToken> },
): Promise<BatchToken> {
  return await BatchToken.open({
    handed,
    now: (): number => T0,
    ask: sign.ask,
    provider: 'Microsoft Graph',
    sourceId: 'source-1',
  });
}

describe('issuedToken', (): void => {
  it('reads the lifetime a provider names in seconds, as a number or a string of digits', (): void => {
    expect(issuedToken('t', 3_599, T0)).toEqual({ token: 't', expiresAt: T0 + 3_599_000 });
    expect(issuedToken('t', '3600', T0)).toEqual({ token: 't', expiresAt: T0 + 3_600_000 });
  });

  it('names no expiry where the provider named no lifetime it could read', (): void => {
    for (const lifetime of [undefined, 0, -5, '', 'an hour', '3600.5', Number.NaN, null]) {
      expect(issuedToken('t', lifetime, T0)).toEqual({ token: 't' });
    }
  });
});

describe('readerTokenServes', (): void => {
  it('serves a batch begun more than two minutes before its expiry, and no batch after', (): void => {
    const token = { token: 't', expiresAt: T0 + READER_TOKEN_MARGIN_MS + 1 };
    expect(readerTokenServes(token, T0)).toBe(true);
    expect(readerTokenServes(token, T0 + 1)).toBe(false);
    expect(readerTokenServes({ token: 't', expiresAt: T0 - 1 }, T0)).toBe(false);
  });
});

describe('BatchToken', (): void => {
  it('reads with a handed token that serves, asks for none and hands none back', async (): Promise<void> => {
    const sign = provider({ token: 'new', expiresAt: T0 + 3_600_000 });
    const token = await opened({ token: 'handed', expiresAt: T0 + 3_600_000 }, sign);
    expect(token.bearer).toBe('handed');
    expect(token.handBack()).toBeUndefined();
    expect(sign.asked()).toBe(0);
  });

  it('asks for a token in place of one handed within two minutes of its expiry, and hands it back', async (): Promise<void> => {
    const sign = provider({ token: 'new', expiresAt: T0 + 3_600_000 });
    const token = await opened({ token: 'handed', expiresAt: T0 + 60_000 }, sign);
    expect(token.bearer).toBe('new');
    expect(token.handBack()).toEqual({ token: 'new', expiresAt: T0 + 3_600_000 });
    expect(sign.asked()).toBe(1);
  });

  it('asks for a token where none was handed, and hands back none the provider named no lifetime for', async (): Promise<void> => {
    const sign = provider({ token: 'new' });
    const token = await opened(undefined, sign);
    expect(token.bearer).toBe('new');
    expect(token.handBack()).toBeUndefined();
    expect(sign.asked()).toBe(1);
  });

  it('renews a handed token the provider refused once, and never one it asked for itself', async (): Promise<void> => {
    const logged = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    try {
      const sign = provider({ token: 'new', expiresAt: T0 + 3_600_000 });
      const token = await opened({ token: 'handed', expiresAt: T0 + 3_600_000 }, sign);
      await expect(token.renew()).resolves.toBe(true);
      expect(token.bearer).toBe('new');
      expect(token.handBack()).toEqual({ token: 'new', expiresAt: T0 + 3_600_000 });
      await expect(token.renew()).resolves.toBe(false);
      expect(sign.asked()).toBe(1);
      const lines = logged.mock.calls.map(([line]): string => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"sourceId":"source-1"');
      expect(lines[0]).not.toContain('handed');
      expect(lines[0]).not.toContain('"new"');
    } finally {
      logged.mockRestore();
    }
  });
});
