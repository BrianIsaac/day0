import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { IssuedTokens } from '../../../src/surfaces/mcp-oauth';
import {
  accessTokenFor,
  heldFromRows,
  runScheduledRefresh,
  SCHEDULED_REFRESH_RETRIES,
  TokenRefreshRefused,
  type HeldTokens,
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
}

/** A keeper over one in-memory pair that counts every read of the refresh token. */
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
    refreshToken: async (_ctx, _id, expectedGeneration): Promise<string | null> => {
      refreshReads += 1;
      if (pair.generation !== expectedGeneration) return null;
      if (!pair.refresh) throw new Error('No live refresh token is held for this authorisation.');
      return pair.refresh;
    },
    rotate: async (_ctx, rotation): Promise<RotationOutcome> => {
      rotations.push(rotation);
      if (pair.revoked) return { ok: false, reason: 'gone' };
      if (pair.generation !== rotation.expectedGeneration) return { ok: false, reason: 'stale' };
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
    const keeper = memoryKeeper(pairFor({ system: 'slack', expiresAt: NOW - 1 }));
    const refresher = scriptedRefresher(async (): Promise<IssuedTokens> => {
      throw new Error('no exchange expected');
    });
    await expect(accessTokenFor(ctx, CREDENTIAL, storeDeps(keeper, refresher))).resolves.toBe(
      'access-0',
    );
    expect(keeper.refreshReads()).toBe(0);
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
