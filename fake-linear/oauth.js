/**
 * The fake's OAuth endpoints: `api.linear.app/oauth/token` (client credentials, the authorisation
 * code with PKCE, the refresh), `api.linear.app/oauth/revoke`, and `linear.app/oauth/authorize`,
 * the page where a person consents with one click. Each answer is the one real Linear gave the
 * real-vendor walks of 3 October 2026 (round 0141: R-V and the re-walk), word for word, status and
 * body; where no walk saw an answer, the handler says so and follows Linear's documentation.
 */
import { escapeHtml, formOf, json, page } from './http.js';
import { ACCESS_SECONDS, APP_ACTOR_SECONDS, scopeSet } from './grants.js';

/** Recorded (2 October, `TOKEN_INVALID_CLIENT`): a client id Linear never issued, either grant. */
const INVALID_CLIENT = Object.freeze({
  error: 'invalid_client',
  error_description: 'Invalid client: client is invalid',
});

/**
 * Documented, not seen: client credentials asked of an app without the grant turned on
 * (`TOKEN_GRANT_NOT_ENABLED`). A real walk must see it on an app with the toggle off.
 */
const GRANT_NOT_ENABLED = Object.freeze({
  error: 'Error',
  error_description: 'Client does not support the client_credentials grant type',
});

/** Seen (the re-walk, row 3): the refresh of a grant revoked at Linear, under HTTP 400. */
const REFRESH_TOKEN_REVOKED = Object.freeze({
  error: 'invalid_request',
  error_description: 'Refresh token revoked',
});

/**
 * Documented, not seen: a refresh token Linear does not know or that was spent past its 30-minute
 * grace (`TOKEN_INVALID_GRANT`). A real walk must replay a refresh token 31 minutes after its use.
 */
const REFRESH_TOKEN_INVALID = Object.freeze({
  error: 'invalid_grant',
  error_description: 'Refresh token is invalid or expired',
});

/**
 * Not seen, and not worded by Linear's pages: a code that is unknown, used, expired, or exchanged
 * with another redirect or verifier. RFC 6749's `invalid_grant`, with this fake's own words. A real
 * walk must exchange a used code and a code with a wrong verifier.
 */
const CODE_INVALID = Object.freeze({
  error: 'invalid_grant',
  error_description: 'The authorization code is invalid or expired',
});

/** Seen (R41V-1; the re-walk, row 4): a live token revoked, with no client authentication. */
const REVOKED = Object.freeze({ success: true });

/** Seen (R41V-8; the re-walk, rows 2 and 4): a token whose grant had already ended, under 401. */
const ALREADY_REVOKED = Object.freeze({ error: 'Token has already been revoked.' });

/** Seen (the re-walk, row 10, R41X-1): a token Linear never issued, under 401. */
const TOKEN_NOT_FOUND = Object.freeze({ error: 'Token not found' });

/** Seen (R41V, the person's token, (a)): Linear's words for `app:assignable` without `actor=app`. */
const SCOPES_NOT_VALID_FOR_ACTOR = 'The scopes requested are not valid for this actor mode.';

/**
 * The scope words Linear's consent prints for each scope (R41V P4; the re-walk, row 2). Only the
 * three the walks saw; another scope is printed by its name.
 */
const SCOPE_WORDS = Object.freeze({
  read: 'Read access',
  write: 'Write access',
  'app:assignable': 'Assign issues and projects to the app in teams it can access',
});

/**
 * Create the OAuth endpoints.
 *
 * @param {{ apps: readonly import('./linear').FakeLinearApp[], grants: import('./linear').FakeGrants, workspace: import('./linear').FakeWorkspace, signedIn: () => import('./linear').WorkspaceUser | undefined, now: () => number }} context
 */
export function createOAuth(context) {
  const { apps, grants, workspace, signedIn, now } = context;

  /**
   * @param {string | null} clientId
   * @returns {import('./linear').FakeLinearApp | undefined}
   */
  const appById = (clientId) => apps.find((app) => app.clientId === clientId);

  /**
   * A token answer's `expires_in`: the access token's remaining life, in whole seconds, as a
   * replayed refresh answered it (86,397 a few seconds after the pair was minted, R41V P7).
   *
   * @param {import('./linear').FakeToken} token
   */
  const expiresIn = (token) =>
    token.expiresAt === null
      ? undefined
      : Math.max(0, Math.floor((token.expiresAt - now()) / 1000));

  /**
   * @param {{ access: import('./linear').FakeToken, refresh: import('./linear').FakeToken }} pair
   */
  function pairAnswer(pair) {
    return json(200, {
      access_token: pair.access.value,
      token_type: 'Bearer',
      expires_in: expiresIn(pair.access) ?? ACCESS_SECONDS,
      scope: pair.access.scopes.join(' '),
      refresh_token: pair.refresh.value,
    });
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function token(request) {
    const form = await formOf(request);
    const app = appById(form.get('client_id'));
    // Not seen: a known client id with a wrong secret. Linear's pages give no words of their own;
    // the recorded answer for an unknown client is the one a real walk is expected to see.
    if (!app || form.get('client_secret') !== app.clientSecret) {
      return json(400, INVALID_CLIENT);
    }
    const grant = form.get('grant_type');
    if (grant === 'client_credentials') {
      if (!app.clientCredentials) return json(400, GRANT_NOT_ENABLED);
      const appUser = workspace.installApp(app);
      const issued = grants.issueAppActor(app.clientId, appUser.id, scopeSet(form.get('scope')));
      // Documented (L2), no refresh token paired; seen: the scope printed sorted, space-separated.
      return json(200, {
        access_token: issued.value,
        token_type: 'Bearer',
        expires_in: expiresIn(issued) ?? APP_ACTOR_SECONDS,
        scope: issued.scopes.join(' '),
      });
    }
    if (grant === 'authorization_code') {
      const exchanged = grants.exchangeCode(
        app.clientId,
        form.get('code') ?? '',
        form.get('redirect_uri') ?? '',
        form.get('code_verifier') ?? '',
      );
      if ('refused' in exchanged) return json(400, CODE_INVALID);
      return pairAnswer(exchanged);
    }
    if (grant === 'refresh_token') {
      const refreshed = grants.refresh(app.clientId, form.get('refresh_token') ?? '');
      if ('refused' in refreshed) {
        return json(
          400,
          refreshed.refused === 'revoked' ? REFRESH_TOKEN_REVOKED : REFRESH_TOKEN_INVALID,
        );
      }
      return pairAnswer(refreshed);
    }
    // Not seen, and Linear's pages give no words: RFC 6749's error for any other grant.
    return json(400, { error: 'unsupported_grant_type' });
  }

  /**
   * Revoke one token, with no client authentication (seen, R41V-1): its whole grant ends.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function revoke(request) {
    const form = await formOf(request);
    const held = grants.find(form.get('token') ?? '');
    // Not seen: whether Linear still knows a token past its expiry (the re-walk's R41X-1 command).
    // Answered as a token it does not know; a real walk must revoke an expired per-employee token.
    if (!held || grants.stateOf(held) === 'expired') {
      return json(401, TOKEN_NOT_FOUND);
    }
    if (grants.stateOf(held) === 'revoked') return json(401, ALREADY_REVOKED);
    grants.revokeGrant(held.grantId);
    return json(200, REVOKED);
  }

  /**
   * The authorise request's problem, as a page, or what it asks for.
   *
   * @param {URLSearchParams} params
   * @returns {{ refusal: Response } | { app: import('./linear').FakeLinearApp, scopes: string[], actorApp: boolean }}
   */
  function checkAuthorise(params) {
    const app = appById(params.get('client_id'));
    const redirect = params.get('redirect_uri') ?? '';
    // Not seen: an unknown client or an unregistered redirect. Linear shows an error page; its
    // words are this fake's own. A real walk must open a link with each.
    if (!app) return { refusal: errorPage('This application could not be found.') };
    if (!app.redirectUris.includes(redirect)) {
      return { refusal: errorPage('The redirect URI is not registered for this application.') };
    }
    if (params.get('response_type') !== 'code') {
      return { refusal: errorPage('Only the code response type is supported.') };
    }
    const scopes = scopeSet(params.get('scope') || 'read');
    const actorApp = params.get('actor') === 'app';
    if (!actorApp && scopes.includes('app:assignable')) {
      return { refusal: errorPage(SCOPES_NOT_VALID_FOR_ACTOR) };
    }
    return { app, scopes, actorApp };
  }

  /**
   * @param {string} words
   * @returns {Response}
   */
  function errorPage(words) {
    // Seen as page text only (R41V); the status is not logged. 400, as an OAuth error page.
    return page(400, 'Linear', `<h1>Linear</h1><p role="alert">${escapeHtml(words)}</p>`);
  }

  /**
   * The consent page: the app's name, what it asks for, and one Authorize button.
   *
   * @param {URLSearchParams} params
   * @param {import('./linear').FakeLinearApp} app
   * @param {string[]} scopes
   * @returns {Response}
   */
  function consent(params, app, scopes) {
    const hidden = [...params.entries()]
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join('');
    // The walks saw the lines in this order: read, write, then the app's capability.
    const known = Object.keys(SCOPE_WORDS);
    const ordered = [
      ...known.filter((scope) => scopes.includes(scope)),
      ...scopes.filter((scope) => !known.includes(scope)),
    ];
    const lines = ordered
      .map(
        (scope) =>
          `<li>${escapeHtml(SCOPE_WORDS[/** @type {keyof typeof SCOPE_WORDS} */ (scope)] ?? scope)}</li>`,
      )
      .join('');
    return page(
      200,
      `Authorize ${app.name}`,
      `<h1>${escapeHtml(app.name)} is requesting access</h1>` +
        `<ul>${lines}<li>Team access: All public teams</li></ul>` +
        '<p class="note">A test double of Linear: nothing here reaches Linear.</p>' +
        `<form method="post" action="/oauth/authorize">${hidden}` +
        '<button type="submit" name="decision" value="authorize">Authorize</button>' +
        '<button type="submit" name="decision" value="cancel">Cancel</button></form>',
    );
  }

  /**
   * @param {URLSearchParams} params
   * @param {Record<string, string>} values
   * @returns {Response}
   */
  function redirectBack(params, values) {
    const destination = new URL(params.get('redirect_uri') ?? '');
    for (const [name, value] of Object.entries(values)) destination.searchParams.set(name, value);
    const state = params.get('state');
    if (state !== null) destination.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function authorize(request) {
    const params =
      request.method === 'POST' ? await formOf(request) : new URL(request.url).searchParams;
    const checked = checkAuthorise(params);
    if ('refusal' in checked) return checked.refusal;
    const decision = params.get('decision');
    if (decision === null) return consent(params, checked.app, checked.scopes);
    if (decision !== 'authorize') {
      // Documented (RFC 6749), not seen: a declined consent.
      return redirectBack(params, { error: 'access_denied' });
    }
    const person = signedIn();
    if (!person) return errorPage('Sign in to Linear to continue.');
    // Documented (L1): "admin permissions are required to complete the installation".
    if (checked.actorApp && !person.admin) {
      return errorPage('Admin permissions are required to install this application.');
    }
    // Seen (the re-walk, row 2): the consent installs the app user even when its code is never
    // exchanged; a person's consent issues a token that acts as that person (R41V (b)).
    const actor = checked.actorApp
      ? { kind: /** @type {const} */ ('app'), appUserId: workspace.installApp(checked.app).id }
      : { kind: /** @type {const} */ ('person'), personId: person.id };
    const method = params.get('code_challenge_method');
    const challenge = params.get('code_challenge');
    if (challenge !== null && method !== 'S256') {
      return errorPage('Only the S256 code challenge method is supported.');
    }
    const code = grants.issueCode({
      clientId: checked.app.clientId,
      redirectUri: params.get('redirect_uri') ?? '',
      challenge,
      scopes: checked.scopes,
      actor,
    });
    return redirectBack(params, { code });
  }

  return { token, revoke, authorize };
}
