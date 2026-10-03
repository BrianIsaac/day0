import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { getFunctionName } from 'convex/server';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { IssuedTokens } from '../../../src/surfaces/mcp-oauth';
import { sealForOwner } from '../../../src/lib/credential-crypto';
import { LIVE_TOKEN_LEASE_POLLS, REFRESH_LEASE_MS } from '../../../src/surfaces/refresh-lease';
import {
  accessTokenFor,
  heldFromRows,
  nativeTokenKeeper,
  runScheduledRefresh,
  SCHEDULED_REFRESH_RETRIES,
  TokenRefreshRefused,
  type ClaimedRefreshToken,
  type HeldTokens,
  type RefreshWords,
  type RotateTokens,
  type RotationOutcome,
  type TokenKeeper,
  type TokenRefresher,
  type TokenStoreBackend,
  type TokenStoreDeps,
} from '../../../src/surfaces/token-store';

const CREDENTIAL = 'credential-1' as Id<'credentials'>;
const NOW = 1_800_000_000_000;
const ctx = {} as ActionCtx;
const CONNECTION = { _id: 'connection-1' } as unknown as Doc<'organisationConnections'>;

/** A pair kept in memory, as the native keeper keeps it in rows. */
interface KeptPair {
  access: string;
  refresh: string | null;
  generation: number;
  expiresAt?: number;
  system: string;
  revoked: boolean;
  /** The refresh lease on the row, as `credentials.refreshingUntil` holds it. */
  refreshingUntil?: number;
}

/**
 * A keeper over one in-memory pair that counts every claim of the refresh token, and takes and
 * clears the lease as the native keeper's mutations do.
 */
function memoryKeeper(pair: KeptPair): TokenKeeper & {
  readonly refreshReads: () => number;
  readonly rotations: RotateTokens[];
} {
  let refreshReads = 0;
  const rotations: RotateTokens[] = [];
  const held = (): HeldTokens => ({
    credentialId: CREDENTIAL,
    ownerKey: 'owner-1',
    generation: pair.generation,
    ...(pair.expiresAt === undefined ? {} : { expiresAt: pair.expiresAt }),
    issuedBy: { system: pair.system, grant: 'authorisation-code' },
    refreshable: pair.refresh !== null,
    connection: CONNECTION,
    ...(pair.refreshingUntil === undefined ? {} : { refreshingUntil: pair.refreshingUntil }),
  });
  return {
    refreshReads: (): number => refreshReads,
    rotations,
    land: async (): Promise<Id<'credentials'>> => CREDENTIAL,
    read: async (): Promise<HeldTokens | null> => held(),
    accessToken: async (): Promise<string> => {
      if (pair.revoked) throw new Error('Credential is unavailable.');
      return pair.access;
    },
    claimRefreshToken: async (_ctx, claim): Promise<ClaimedRefreshToken> => {
      refreshReads += 1;
      if (pair.revoked) return { kind: 'gone' };
      if (pair.generation !== claim.expectedGeneration) return { kind: 'moved' };
      if (pair.refreshingUntil !== undefined && pair.refreshingUntil > claim.now) {
        return { kind: 'leased', until: pair.refreshingUntil };
      }
      if (!pair.refresh) throw new Error('No live refresh token is held for this authorisation.');
      pair.refreshingUntil = claim.now + REFRESH_LEASE_MS;
      return { kind: 'claimed', presented: pair.refresh, leaseUntil: pair.refreshingUntil };
    },
    releaseRefreshLease: async (_ctx, lease): Promise<void> => {
      if (pair.refreshingUntil === lease.leaseUntil) pair.refreshingUntil = undefined;
    },
    rotate: async (_ctx, rotation): Promise<RotationOutcome> => {
      rotations.push(rotation);
      if (pair.revoked) return { ok: false, reason: 'gone' };
      if (pair.generation !== rotation.expectedGeneration) return { ok: false, reason: 'stale' };
      pair.refreshingUntil = undefined;
      pair.generation += 1;
      pair.access = rotation.tokens.accessToken;
      pair.refresh = rotation.tokens.refreshToken ?? pair.refresh;
      if (rotation.tokens.expiresAt !== undefined) pair.expiresAt = rotation.tokens.expiresAt;
      return { ok: true, generation: pair.generation };
    },
  };
}

/** A refresher for `issuer:` systems whose exchange answers what the test gives it. */
function scriptedRefresher(
  exchange: (presented: string) => Promise<IssuedTokens>,
  options: { readonly retryable?: boolean } = {},
): TokenRefresher & { readonly discarded: string[] } {
  const discarded: string[] = [];
  return {
    discarded,
    name: 'issuer',
    owns: (issuedBy): boolean => issuedBy.system.startsWith('issuer:'),
    readRefreshMarginMs: 60_000,
    retryable: (): boolean => options.retryable ?? false,
    prepare: async () => ({
      ok: true,
      refresh: {
        exchange,
        discard: async (_presented: string, issued: IssuedTokens): Promise<void> => {
          discarded.push(issued.refreshToken ?? '');
        },
      },
    }),
  };
}

function pairFor(overrides: Partial<KeptPair> = {}): KeptPair {
  return {
    access: 'access-0',
    refresh: 'refresh-0',
    generation: 0,
    expiresAt: NOW + 30_000,
    system: 'issuer:example',
    revoked: false,
    ...overrides,
  };
}

function storeDeps(
  keeper: TokenKeeper,
  refresher: TokenRefresher,
  backends: readonly TokenStoreBackend[] = [],
): TokenStoreDeps {
  return { keeper, refreshers: [refresher], now: (): number => NOW, backends };
}

/** A keeper whose one row names another store, as a Nango-held credential's does. */
function heldElsewhere(keeper: TokenKeeper): TokenKeeper {
  return {
    ...keeper,
    read: async (context, id): Promise<HeldTokens | null> => {
      const held = await keeper.read(context, id);
      return held ? { ...held, tokenStore: 'nango' } : null;
    },
  };
}

describe('the token store', (): void => {
  it('hands back the stored access token and never reads the refresh token while it is outside the margin', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW + 10 * 60_000 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-0',
    );
    expect(keeper.refreshReads()).toBe(0);
  });

  it('refreshes a token inside its margin and writes the rotation at the generation it read', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const refresher = scriptedRefresher(
      async (presented): Promise<IssuedTokens> => ({
        accessToken: `access-after-${presented}`,
        refreshToken: 'refresh-1',
        expiresAt: NOW + 3_600_000,
      }),
    );
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-after-refresh-0',
    );
    expect(keeper.rotations.map((rotation) => rotation.expectedGeneration)).toEqual([0]);
  });

  it('takes the winner token when a concurrent refresh rotated the pair first', async (): Promise<void> => {
    const pair = pairFor();
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      pair.generation = 1;
      pair.access = 'winner-access';
      return { accessToken: 'loser-access', refreshToken: 'loser-refresh' };
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'winner-access',
    );
  });

  it('keeps using a living token when the issuer refuses the refresh', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW + 30_000 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new TokenRefreshRefused('invalid_grant');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-0',
    );
  });

  it('refuses an expired token whose refresh is refused and says to authorise again', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW - 1 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new TokenRefreshRefused('invalid_grant');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).rejects.toThrow(
      'Refreshing the authorisation was refused: invalid_grant Authorise the card again.',
    );
  });

  it('has the issuer discard what it was issued for a credential revoked during the refresh', async (): Promise<void> => {
    const pair = pairFor({ expiresAt: NOW - 1 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      pair.revoked = true;
      return { accessToken: 'unkept-access', refreshToken: 'unkept-refresh' };
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).rejects.toThrow(
      'The authorisation was revoked while it was being refreshed.',
    );
    expect(refresher.discarded).toEqual(['unkept-refresh']);
  });

  it('reads a token no refresher issued exactly as stored, however close its expiry', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ system: 'slack', expiresAt: NOW + 1 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-0',
    );
    expect(keeper.refreshReads()).toBe(0);
  });

  it('refuses a token past its expiry that nothing held can renew, rather than send it (the review’s m12)', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW - 1, refresh: null }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).rejects.toThrow(
      'The token has expired and nothing Day0 holds can renew it. Authorise the card again.',
    );
    expect(keeper.refreshReads()).toBe(0);
  });
});

describe('the refresh lease (R-S; the wave 11 review’s m11)', (): void => {
  /** A turn of the event loop, so a concurrent refresh can move on while a waiter sleeps. */
  const tick = async (): Promise<void> => {
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
  };

  it('presents the refresh token once when two refreshes run at once, and gives both the one new token', async (): Promise<void> => {
    const pair = pairFor();
    const keeper = memoryKeeper(pair);
    const presented: string[] = [];
    let openExchange = (): void => undefined;
    const exchangeOpen = new Promise<void>((resolve): void => {
      openExchange = resolve;
    });
    const refresher = scriptedRefresher(async (token): Promise<IssuedTokens> => {
      presented.push(token);
      await exchangeOpen;
      return { accessToken: `access-after-${token}`, refreshToken: 'refresh-1' };
    });
    const deps: TokenStoreDeps = {
      ...storeDeps(keeper, refresher),
      // The waiter's first sleep lets the holder's exchange answer.
      sleep: async (): Promise<void> => {
        openExchange();
        await tick();
      },
    };
    const both = await Promise.all([
      accessTokenFor(ctx, CREDENTIAL, deps),
      accessTokenFor(ctx, CREDENTIAL, deps),
    ]);
    expect(presented).toEqual(['refresh-0']);
    expect(both).toEqual(['access-after-refresh-0', 'access-after-refresh-0']);
    expect(keeper.rotations).toHaveLength(1);
    expect(pair.refreshingUntil).toBeUndefined();
  });

  it('takes over a lease its holder left behind once the lease has lapsed', async (): Promise<void> => {
    const pair = pairFor({ refreshingUntil: NOW - 1 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(
      async (token): Promise<IssuedTokens> => ({ accessToken: `access-after-${token}` }),
    );
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-after-refresh-0',
    );
    expect(pair.refreshingUntil).toBeUndefined();
  });

  it('waits for a holder that lets its lease end without a rotation, then takes the lease itself', async (): Promise<void> => {
    const pair = pairFor({ refreshingUntil: NOW + 10_000 });
    const keeper = memoryKeeper(pair);
    const presented: string[] = [];
    const refresher = scriptedRefresher(async (token): Promise<IssuedTokens> => {
      presented.push(token);
      return { accessToken: `access-after-${token}` };
    });
    const deps: TokenStoreDeps = {
      ...storeDeps(keeper, refresher),
      sleep: async (): Promise<void> => {
        // The holder's exchange failed and it released its lease.
        pair.refreshingUntil = undefined;
      },
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, deps)).resolves.toBe('access-after-refresh-0');
    expect(presented).toEqual(['refresh-0']);
  });

  it('hands back a token that still lives after a short wait when another refresh holds the lease', async (): Promise<void> => {
    const pair = pairFor({ expiresAt: NOW + 30_000, refreshingUntil: NOW + 80_000 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    let slept = 0;
    const deps: TokenStoreDeps = {
      ...storeDeps(keeper, refresher),
      // The holder died: its lease never ends while the reader waits.
      sleep: async (): Promise<void> => {
        slept += 1;
      },
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, deps)).resolves.toBe('access-0');
    // Two claims, each waiting at most the live token's bound, never the whole lease.
    expect(slept).toBeLessThanOrEqual(2 * LIVE_TOKEN_LEASE_POLLS);
  });

  it("waits five seconds in all behind a dead holder's lease while the stored token lives, the claims sharing one budget (the round review's m7)", async (): Promise<void> => {
    const pair = pairFor({ expiresAt: NOW + 30_000, refreshingUntil: NOW + 80_000 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    let slept = 0;
    const deps: TokenStoreDeps = {
      ...storeDeps(keeper, refresher),
      sleep: async (): Promise<void> => {
        slept += 1;
      },
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, deps)).resolves.toBe('access-0');
    expect(slept).toBeLessThanOrEqual(LIVE_TOKEN_LEASE_POLLS);
  });

  it("never hands back a stored token that died while the read waited behind another holder's lease (the round review's m8)", async (): Promise<void> => {
    // Three seconds left, and the holder died: its lease never ends while the reader waits.
    const pair = pairFor({ expiresAt: NOW + 3_000, refreshingUntil: NOW + 80_000 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    let clock = NOW;
    const deps: TokenStoreDeps = {
      ...storeDeps(keeper, refresher),
      now: (): number => clock,
      sleep: async (ms: number): Promise<void> => {
        clock += ms;
      },
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, deps)).rejects.toThrow(
      'The authorisation server could not be reached to refresh the token',
    );
  });

  it("never hands back a stored token that died while its refresh was refused (the round review's m8)", async (): Promise<void> => {
    const pair = pairFor({ expiresAt: NOW + 3_000 });
    const keeper = memoryKeeper(pair);
    let clock = NOW;
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      // The exchange takes longer than the token has left, then fails.
      clock += 30_000;
      throw new Error('fetch failed');
    });
    const deps: TokenStoreDeps = { ...storeDeps(keeper, refresher), now: (): number => clock };
    await expect(accessTokenFor(ctx, CREDENTIAL, deps)).rejects.toThrow(
      'The authorisation server could not be reached to refresh the token',
    );
  });

  it('ends its own lease when the exchange cannot be made, so the next refresh need not wait', async (): Promise<void> => {
    const pair = pairFor();
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('fetch failed');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-0',
    );
    expect(pair.refreshingUntil).toBeUndefined();
  });

  it('tries a scheduled refresh again when other refreshes held the lease throughout, and records nothing', async (): Promise<void> => {
    const pair = pairFor({ refreshingUntil: NOW + 10_000 });
    const keeper = memoryKeeper(pair);
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    const retries: Array<[number, number]> = [];
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 0 },
      {
        ...storeDeps(keeper, refresher),
        sleep: async (): Promise<void> => {
          // Each holder's lease ends and another refresh takes the next.
          pair.refreshingUntil = (pair.refreshingUntil ?? NOW) + 1;
        },
        retryAfter: async (delayMs, attempt): Promise<void> => {
          retries.push([delayMs, attempt]);
        },
        recordRefusal: async (): Promise<void> => {
          throw new Error('no refusal expected');
        },
      },
    );
    expect(retries).toEqual([[60_000, 1]]);
  });
});

describe('a refresher with its own words and its own rotation write (join 5)', (): void => {
  /** Words an issuer names its refresh's failures in, each marked so a test can tell them apart. */
  const ISSUER_WORDS: RefreshWords = {
    reason: (error: unknown): string => (error instanceof Error ? error.message : 'unknown'),
    refused: (message: string): string => `Issuer refused: ${message}`,
    revokedMeanwhile: 'Issuer token revoked meanwhile.',
    unreachableWhenExpired: (reason: string): Error => new Error(`Issuer unreachable: ${reason}`),
    refusedWhenExpired: (refusal: string): Error => new Error(`${refusal} Install again.`),
    unreachableAfter: (attempts: number, reason: string): string =>
      `Issuer unreachable ${attempts} times: ${reason}`,
    failed: (reason: string): string => `Issuer failed: ${reason}`,
  };

  it('refuses an expired token in the issuer’s words, not the store’s', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW - 1 }));
    const refresher: TokenRefresher = {
      ...scriptedRefresher(async (): Promise<IssuedTokens> => {
        throw new TokenRefreshRefused('invalid_grant');
      }),
      words: ISSUER_WORDS,
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).rejects.toThrow(
      'Issuer refused: invalid_grant Install again.',
    );
  });

  it('records a scheduled refresh’s spent retries in the issuer’s words', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const refresher: TokenRefresher = {
      ...scriptedRefresher(
        async (): Promise<IssuedTokens> => {
          throw new Error('fetch failed');
        },
        { retryable: true },
      ),
      words: ISSUER_WORDS,
    };
    const refusals: string[] = [];
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 0, attempt: SCHEDULED_REFRESH_RETRIES },
      {
        ...storeDeps(keeper, refresher),
        retryAfter: async (): Promise<void> => {
          throw new Error('no retry expected');
        },
        recordRefusal: async (reason): Promise<void> => {
          refusals.push(reason);
        },
      },
    );
    expect(refusals).toEqual([
      `Issuer unreachable ${SCHEDULED_REFRESH_RETRIES + 1} times: fetch failed`,
    ]);
  });

  it('writes the rotation through the issuer’s own write, never the keeper’s', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const written: RotateTokens[] = [];
    const refresher: TokenRefresher = {
      ...scriptedRefresher(
        async (): Promise<IssuedTokens> => ({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
      ),
      rotate: async (_ctx, rotation): Promise<RotationOutcome> => {
        written.push(rotation);
        return { ok: true, generation: rotation.expectedGeneration + 1 };
      },
    };
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-1',
    );
    expect(written.map((rotation) => [rotation.expectedGeneration, rotation.ownerKey])).toEqual([
      [0, 'owner-1'],
    ]);
    expect(keeper.rotations).toEqual([]);
  });
});

describe('the store a row names', (): void => {
  it('asks the backend the row names for the token, and neither reads nor refreshes the row', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW - 1 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no native refresh expected');
    });
    const asked: string[] = [];
    const nango: TokenStoreBackend = {
      kind: 'nango',
      accessTokenFor: async (_context, id): Promise<string> => {
        asked.push(id);
        return 'nango-live-token';
      },
    };
    await expect(
      accessTokenFor(ctx, CREDENTIAL, storeDeps(heldElsewhere(keeper), refresher, [nango])),
    ).resolves.toBe('nango-live-token');
    expect(asked).toEqual([CREDENTIAL]);
    expect(keeper.refreshReads()).toBe(0);
    expect(keeper.rotations).toEqual([]);
  });

  it('refuses a row naming a store this deployment has not configured', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ expiresAt: NOW + 10 * 60_000 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no native refresh expected');
    });
    await expect(
      accessTokenFor(ctx, CREDENTIAL, storeDeps(heldElsewhere(keeper), refresher)),
    ).rejects.toThrow('The nango token store is not configured on this deployment.');
  });

  it('never schedules a native refresh of a token another store keeps', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no native refresh expected');
    });
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 0 },
      {
        ...storeDeps(heldElsewhere(keeper), refresher),
        retryAfter: async (): Promise<void> => {
          throw new Error('no retry expected');
        },
        recordRefusal: async (): Promise<void> => {
          throw new Error('no refusal expected');
        },
      },
    );
    expect(keeper.refreshReads()).toBe(0);
  });
});

describe('the scheduled refresh', (): void => {
  it('queues a retry with a doubled wait when the server cannot be reached', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const refresher = scriptedRefresher(
      async (): Promise<IssuedTokens> => {
        throw new Error('fetch failed');
      },
      { retryable: true },
    );
    const retries: Array<[number, number]> = [];
    const refusals: string[] = [];
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 0, attempt: 2 },
      {
        ...storeDeps(keeper, refresher),
        retryAfter: async (delayMs, attempt): Promise<void> => {
          retries.push([delayMs, attempt]);
        },
        recordRefusal: async (reason): Promise<void> => {
          refusals.push(reason);
        },
      },
    );
    expect(retries).toEqual([[240_000, 3]]);
    expect(refusals).toEqual([]);
  });

  it('records the refusal once the retries run out', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor());
    const refresher = scriptedRefresher(
      async (): Promise<IssuedTokens> => {
        throw new Error('fetch failed');
      },
      { retryable: true },
    );
    const refusals: string[] = [];
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 0, attempt: SCHEDULED_REFRESH_RETRIES },
      {
        ...storeDeps(keeper, refresher),
        retryAfter: async (): Promise<void> => {
          throw new Error('no retry expected');
        },
        recordRefusal: async (reason): Promise<void> => {
          refusals.push(reason);
        },
      },
    );
    expect(refusals).toEqual([
      `The authorisation server could not be reached to refresh the token after ${SCHEDULED_REFRESH_RETRIES + 1} attempts: fetch failed`,
    ]);
  });

  it('does nothing when another refresh has moved the pair on', async (): Promise<void> => {
    const keeper = memoryKeeper(pairFor({ generation: 4 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    await runScheduledRefresh(
      ctx,
      { credentialId: CREDENTIAL, generation: 3 },
      {
        ...storeDeps(keeper, refresher),
        retryAfter: async (): Promise<void> => {
          throw new Error('no retry expected');
        },
        recordRefusal: async (): Promise<void> => {
          throw new Error('no refusal expected');
        },
      },
    );
    expect(keeper.refreshReads()).toBe(0);
  });
});

describe('heldFromRows', (): void => {
  it('reads the metadata of one snapshot, an absent generation as 0 and an absent store as native', (): void => {
    const access = {
      userId: 'owner-1',
      expiresAt: NOW,
      issuedBy: { system: 'mcp:mcp.example.com', grant: 'authorisation-code' },
    } as unknown as Doc<'credentials'>;
    const refresh = { ciphertext: 'sealed' } as unknown as Doc<'credentials'>;
    expect(heldFromRows(CREDENTIAL, { access, refresh, connection: CONNECTION })).toEqual({
      credentialId: CREDENTIAL,
      ownerKey: 'owner-1',
      generation: 0,
      expiresAt: NOW,
      issuedBy: access.issuedBy,
      refreshable: true,
      connection: CONNECTION,
      tokenStore: 'native',
    });
  });

  it('reads a revoked refresh token as not refreshable', (): void => {
    const access = { userId: 'owner-1' } as unknown as Doc<'credentials'>;
    const refresh = { ciphertext: 'sealed', revokedAt: NOW } as unknown as Doc<'credentials'>;
    expect(heldFromRows(CREDENTIAL, { access, refresh, connection: null }).refreshable).toBe(false);
  });
});

describe('every rung in the deployment reads its bearer through the token store', (): void => {
  const convexDirectory = new URL('../../../convex/', import.meta.url);

  /** The text of each `decrypt:` dependency a module hands an adapter, up to the next property. */
  function decryptDependencies(source: string): string[] {
    return [
      ...source.matchAll(/\bdecrypt:\s*([\s\S]*?)(?=\n\s{0,12}[a-zA-Z]+:\s|\n\s*\},?\n)/g),
    ].map((match) => match[1]);
  }

  it('hands no adapter a plain decrypt, which would send a Nango pointer or an expired token', (): void => {
    const offenders: string[] = [];
    for (const entry of readdirSync(convexDirectory)) {
      if (!entry.endsWith('.ts')) continue;
      // Comments removed, so prose that names a decrypt is not a dependency.
      const source = readFileSync(new URL(entry, convexDirectory), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
      for (const dependency of decryptDependencies(source)) {
        if (/decryptCredential\b|credentials\.decrypt\b/.test(dependency)) offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the native keeper’s claim (R-S)', (): void => {
  it('ends the lease and says why when the claimed refresh token cannot be opened, even if the release fails', async (): Promise<void> => {
    const key = randomBytes(32).toString('base64');
    const refresh = {
      _id: 'refresh-1',
      userId: 'owner-1',
      // Sealed for another owner than the row names, so the keeper refuses to open it.
      ...sealForOwner('refresh-elsewhere', { current: key }, 'someone-else'),
    } as unknown as Doc<'credentials'>;
    const called: string[] = [];
    const failingCtx = {
      runMutation: async (reference: unknown): Promise<unknown> => {
        const name = getFunctionName(reference as never);
        called.push(name);
        if (name === 'refreshLease:claim') {
          return { kind: 'claimed', leaseUntil: NOW + REFRESH_LEASE_MS, refresh };
        }
        throw new Error('the backend could not be reached');
      },
    } as unknown as ActionCtx;
    const keeper = nativeTokenKeeper(() => ({ current: key }));
    const claimed = keeper.claimRefreshToken(failingCtx, {
      credentialId: CREDENTIAL,
      expectedGeneration: 0,
      now: NOW,
    });
    await expect(claimed).rejects.toThrow('Credential decryption failed');
    await expect(claimed).rejects.not.toThrow('the backend could not be reached');
    expect(called).toEqual(['refreshLease:claim', 'refreshLease:release']);
  });
});
