/**
 * The fake's tokens and authorisation codes: what Linear issued, to whom, under which grant, and
 * whether each still lives. Every rule here is one the two real-vendor walks of 3 October 2026 saw
 * on real Linear (round 0141: R-V and the re-walk), or, where no walk saw it, Linear's
 * documentation (the wave 11 file, section 8, L2 and L3), said so at the rule.
 *
 * Token values are fakes in short shapes (`lin_oauth_fake_access_3`), never Linear's real full
 * shape: a fake in that shape is refused by push protection even in a test.
 */
import { createHash } from 'node:crypto';

/** A client-credentials token's life (L2: "valid for 30 days"; the walk saw `expiresAt` +30 days). */
export const APP_ACTOR_SECONDS = 30 * 24 * 60 * 60 - 1;

/** An authorisation-code or refreshed access token's life (L3: "valid for 24 hours"). */
export const ACCESS_SECONDS = 24 * 60 * 60 - 1;

/**
 * How long a spent refresh token still answers with the pair it was exchanged for (L3: "a 30-minute
 * grace period"; R41V P7 saw a replay inside it return the same pair).
 */
export const REFRESH_GRACE_MS = 30 * 60 * 1000;

/**
 * How long an authorisation code waits for its exchange. Not seen by either walk and not given by
 * Linear's page: RFC 6749's recommended ten minutes. A real walk must see an exchange after it.
 */
export const CODE_SECONDS = 10 * 60;

/**
 * The scopes a request names, comma- or space-separated, as a set in Linear's printed order: real
 * Linear printed `read,write,app:assignable` as `app:assignable read write` (the walks' logs).
 *
 * @param {string | null} raw
 * @returns {string[]}
 */
export function scopeSet(raw) {
  return [...new Set((raw ?? '').split(/[\s,]+/).filter((scope) => scope !== ''))].sort();
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
function sameSet(left, right) {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * Create the token store.
 *
 * @param {() => number} now the clock, in milliseconds
 * @returns {import('./linear').FakeGrants}
 */
export function createGrants(now) {
  /** @type {Map<string, import('./linear').FakeToken>} */
  const tokens = new Map();
  /** @type {Map<string, import('./linear').FakeCode>} */
  const codes = new Map();
  let serial = 0;

  /**
   * @param {string} prefix
   * @returns {string}
   */
  function nextValue(prefix) {
    serial += 1;
    return `${prefix}_${serial}`;
  }

  /**
   * @param {Omit<import('./linear').FakeToken, 'value' | 'serial' | 'issuedAt' | 'revokedAt' | 'spentAt' | 'replay'>} fields
   * @param {string} prefix
   * @returns {import('./linear').FakeToken}
   */
  function mint(fields, prefix) {
    const value = nextValue(prefix);
    /** @type {import('./linear').FakeToken} */
    const token = {
      ...fields,
      value,
      serial,
      issuedAt: now(),
      revokedAt: null,
      spentAt: null,
      replay: null,
    };
    tokens.set(value, token);
    return token;
  }

  /**
   * @param {import('./linear').FakeToken} token
   * @returns {import('./linear').FakeTokenState}
   */
  function stateOf(token) {
    if (token.revokedAt !== null) return 'revoked';
    if (token.expiresAt !== null && token.expiresAt <= now()) return 'expired';
    if (token.spentAt !== null) return 'spent';
    return 'live';
  }

  /**
   * End every token of one grant: on real Linear the first revoke of a pair ends the whole grant,
   * whichever of the two it names (R41V-8; the re-walk, row 2 and W-L5).
   *
   * @param {string} grantId
   */
  function revokeGrant(grantId) {
    for (const token of tokens.values()) {
      if (token.grantId === grantId && token.revokedAt === null) token.revokedAt = now();
    }
  }

  /**
   * A pair for an authorisation-code grant or its refresh: a 24-hour access token and a refresh
   * token, in one grant.
   *
   * @param {{ clientId: string, actor: import('./linear').FakeActor, scopes: string[], grantId: string, grant: 'authorization_code' | 'refresh_token' }} fields
   * @returns {{ access: import('./linear').FakeToken, refresh: import('./linear').FakeToken }}
   */
  function pair(fields) {
    const common = {
      clientId: fields.clientId,
      actor: fields.actor,
      scopes: fields.scopes,
      grantId: fields.grantId,
      grant: fields.grant,
    };
    const access = mint(
      { ...common, kind: 'access', expiresAt: now() + ACCESS_SECONDS * 1000 },
      'lin_oauth_fake_access',
    );
    // A refresh token's own life is not documented and no walk saw one lapse: it lives until spent
    // past its grace or revoked. A real walk must see a refresh token left unused for days.
    const refresh = mint({ ...common, kind: 'refresh', expiresAt: null }, 'lin_refresh_fake');
    return { access, refresh };
  }

  return {
    tokens,
    stateOf,
    find: (value) => tokens.get(value),
    revokeGrant,

    issueAppActor(clientId, appUserId, scopes) {
      // L2, seen on the wire by both walks: a request with another set revokes every app-actor
      // token of the app; a request with the same set leaves the others live (the re-walk, row 11).
      for (const token of tokens.values()) {
        if (
          token.clientId === clientId &&
          token.kind === 'app-actor' &&
          token.revokedAt === null &&
          !sameSet(token.scopes, scopes)
        ) {
          token.revokedAt = now();
        }
      }
      // Each client-credentials token is its own grant: its revoke ends it alone (R41V-1).
      return mint(
        {
          clientId,
          actor: { kind: 'app', appUserId },
          scopes,
          kind: 'app-actor',
          grantId: nextValue('grant'),
          grant: 'client_credentials',
          expiresAt: now() + APP_ACTOR_SECONDS * 1000,
        },
        'lin_oauth_fake_app',
      );
    },

    issueCode(fields) {
      const code = nextValue('lin_code_fake');
      codes.set(code, { ...fields, expiresAt: now() + CODE_SECONDS * 1000, used: false });
      return code;
    },

    exchangeCode(clientId, code, redirectUri, verifier) {
      const held = codes.get(code);
      if (!held || held.used || held.clientId !== clientId || held.expiresAt <= now()) {
        return { refused: 'code' };
      }
      held.used = true;
      if (held.redirectUri !== redirectUri) return { refused: 'redirect' };
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (held.challenge !== null && challenge !== held.challenge) return { refused: 'verifier' };
      return pair({
        clientId,
        actor: held.actor,
        scopes: held.scopes,
        grantId: nextValue('grant'),
        grant: 'authorization_code',
      });
    },

    refresh(clientId, value) {
      const held = tokens.get(value);
      if (!held || held.kind !== 'refresh' || held.clientId !== clientId) {
        return { refused: 'unknown' };
      }
      // Seen: a refresh token whose grant an administrator's "Revoke access", or a revoke of its
      // access token, ended is refused as revoked, whatever its grace (the re-walk, row 3; W-L5).
      if (held.revokedAt !== null) return { refused: 'revoked' };
      // Not seen: a refresh token that lapsed (only a bed's /admin/expire lapses one). Answered as
      // Linear documents a refresh token it no longer takes; a real walk must see one lapse.
      if (stateOf(held) === 'expired') return { refused: 'expired' };
      if (held.spentAt !== null && held.replay !== null) {
        // Seen (R41V P7): a replay inside the grace returns the same new pair, its `expires_in` the
        // new access token's remaining life.
        if (now() - held.spentAt <= REFRESH_GRACE_MS) return held.replay;
        return { refused: 'spent' };
      }
      const fresh = pair({
        clientId,
        actor: held.actor,
        scopes: held.scopes,
        grantId: held.grantId,
        grant: 'refresh_token',
      });
      // Seen (R41V P7): the replaced access token keeps working after the refresh; only the
      // refresh token is spent.
      held.spentAt = now();
      held.replay = fresh;
      return fresh;
    },

    revokeApp(clientId) {
      let ended = 0;
      for (const token of tokens.values()) {
        if (token.clientId === clientId && token.revokedAt === null) {
          token.revokedAt = now();
          ended += 1;
        }
      }
      return ended;
    },

    expire(value) {
      const held = tokens.get(value);
      if (!held) return false;
      held.expiresAt = now();
      return true;
    },
  };
}
