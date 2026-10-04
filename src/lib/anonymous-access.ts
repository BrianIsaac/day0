/**
 * Who may reach the deployment with no signed-in caller, in one place (wave 12, 12-G; the
 * 24 September review's P9-4; the TypeScript standard's 10.4).
 *
 * The rule for a public Convex function: a caller `getCaller` does not admit (no token, a token
 * the domain or address rule refuses, a token on the organisation's reserved key) is refused with
 * the guard's not-authenticated error (`getCallerOrThrow`, `convex/ownership.ts`) before the
 * function reads a row, says which mode the deployment runs in, or does anything else. The
 * functions named in {@link CALLERLESS_FUNCTIONS} are the only exceptions, each with what
 * authorises it and why it must answer before a caller exists.
 *
 * The rule for a route under `app/api/`: a request with no session reaches a handler only where
 * {@link NO_SESSION_ROUTES} names it, and the handler then answers nothing but a refusal, or the
 * work the secret it carries authorises.
 *
 * `tests/convex/anonymous-caller.test.ts` holds every function the generated `api` names to the
 * first rule and `tests/app/api/anonymous-routes.test.ts` holds every route file to the second,
 * so a function or a route added later without a guard fails the gate. `pnpm check:anonymous`
 * asks a running deployment the first.
 */

/** What a public function that answers with no caller may answer it with. */
export type CallerlessAnswer =
  /** A public fact, the same for every caller and published anyway: the deployment's release. */
  | 'public-fact'
  /**
   * Only which rule refused the caller's own token. A request with no token at all is refused as
   * every other function refuses it.
   */
  | 'own-token-refusal'
  /**
   * A refusal in words, or the work a signed secret the request carries authorises; never a row
   * of anyone's. The secret, not a caller, is what admits it.
   */
  | 'secret-or-refusal';

/** A public Convex function that answers a caller the guard does not admit, and why it may. */
export interface CallerlessFunction {
  /** The function as the generated `api` names it: `module:export`. */
  readonly path: string;
  readonly answer: CallerlessAnswer;
  /** What authorises it, and why it must answer before a caller exists. */
  readonly reason: string;
}

/**
 * The public Convex functions that answer with no signed-in caller. Every other public function
 * refuses such a caller first.
 */
export const CALLERLESS_FUNCTIONS: readonly CallerlessFunction[] = [
  {
    path: 'config:release',
    answer: 'public-fact',
    reason:
      'The release string and the date it was first stamped: the same for every caller, ' +
      'published in the repository, and stated to signed-out visitors by the public /setup page.',
  },
  {
    path: 'config:whoAmI',
    answer: 'own-token-refusal',
    reason:
      "The company sign-in's live check (`pnpm check:sign-in`, the callback's check flow) asks " +
      'it with the token the issuer just signed, before that token is known to be a caller: a ' +
      'token the domain or address rule refuses is told which rule refused it, and nothing else.',
  },
  {
    path: 'slackProvisionActions:completeInstall',
    answer: 'secret-or-refusal',
    reason:
      "Slack's install redirect (`/api/oauth/slack`): the person who approves the install at " +
      'Slack may be IT, with no Day0 session. The state this deployment signed, bound to one ' +
      'card, expiring and single-use, is what admits it.',
  },
  {
    path: 'linearIdentityActions:completeAuthorisation',
    answer: 'secret-or-refusal',
    reason:
      "Linear's install redirect (`/api/oauth/linear`): the person who installs the app at " +
      'Linear may be IT, with no Day0 session. The state this deployment signed, bound to one ' +
      'card, expiring and single-use, is what admits it.',
  },
  {
    path: 'mcpOauthActions:completeAuthorisation',
    answer: 'secret-or-refusal',
    reason:
      "An MCP server's authorisation redirect (`/api/oauth/mcp`): it completes only for the " +
      "card's manager, and a browser whose sign-in lapsed during the consent is told so in words " +
      '(before the state is read), so the redirect can send the manager back to sign in.',
  },
  {
    path: 'onboarding:synthesiseFromTranscriptForWebhook',
    answer: 'secret-or-refusal',
    reason:
      "ElevenLabs's post-call webhook (`/api/voice/elevenlabs/webhook`), server to server with " +
      "no person: the route checks ElevenLabs's signature, and the voice session's own " +
      'single-use token, bound to the employee and the conversation, is what admits it.',
  },
];

/** The HTTP verbs a route under `app/api/` exports. */
export type RouteVerb = 'GET' | 'POST';

/** How a route's handler admits a request that carries no session. */
export type NoSessionAdmission =
  /** A state or a signature this deployment (or the vendor, by a shared secret) signed. */
  | 'signed-secret'
  /** The handler is the company sign-in itself, which runs before any session exists. */
  | 'the-sign-in'
  /** The handler refuses a request with no session itself; the proxy lets it reach it. */
  | 'handler-refuses';

/** A route whose handler a request with no session reaches in at least one sign-in mode. */
export interface NoSessionRoute {
  /** The route's path under the app, as its directory names it: `/api/oauth/slack`. */
  readonly path: string;
  readonly verb: RouteVerb;
  readonly admission: NoSessionAdmission;
  /** Why it is reachable with no session, and what such a request gets. */
  readonly reason: string;
}

/**
 * The routes a request with no session reaches, in any of the three sign-in modes (Clerk, the
 * local key, the company sign-in). Every other route is refused by the proxy before its handler
 * runs.
 */
export const NO_SESSION_ROUTES: readonly NoSessionRoute[] = [
  {
    path: '/api/oauth/slack',
    verb: 'GET',
    admission: 'signed-secret',
    reason:
      "Slack's install redirect, in every mode: a redirect to this deployment's own landing, " +
      'with the outcome the signed state allowed.',
  },
  {
    path: '/api/oauth/linear',
    verb: 'GET',
    admission: 'signed-secret',
    reason:
      "Linear's install redirect, in every mode: a redirect to this deployment's own landing, " +
      'with the outcome the signed state allowed.',
  },
  {
    path: '/api/oauth/mcp',
    verb: 'GET',
    admission: 'signed-secret',
    reason:
      "An MCP server's authorisation redirect: reached with no session only where no sign-in is " +
      'configured (Clerk mode with no publishable key), where the deployment refuses it in words.',
  },
  {
    path: '/api/voice/elevenlabs/webhook',
    verb: 'POST',
    admission: 'signed-secret',
    reason:
      "ElevenLabs's post-call webhook, in every mode: refused with 401 unless ElevenLabs's " +
      'signature over the body verifies.',
  },
  {
    path: '/api/seed',
    verb: 'POST',
    admission: 'handler-refuses',
    reason:
      'Public at the Clerk proxy so its handler can answer in JSON: refused with 401 before ' +
      'the body is read when no Clerk session exists.',
  },
  {
    path: '/api/onboarding/synthesise',
    verb: 'POST',
    admission: 'handler-refuses',
    reason:
      'Public at the Clerk proxy so its handler can answer in JSON: refused with 401 before ' +
      'the body is read when no Clerk session exists.',
  },
  {
    path: '/api/auth/oidc/login',
    verb: 'GET',
    admission: 'the-sign-in',
    reason: "The company sign-in's start: a redirect to the customer's issuer.",
  },
  {
    path: '/api/auth/oidc/callback',
    verb: 'GET',
    admission: 'the-sign-in',
    reason:
      "The company sign-in's return from the issuer: refused without the sign-in's own sealed " +
      'transaction cookie.',
  },
  {
    path: '/api/auth/oidc/token',
    verb: 'POST',
    admission: 'the-sign-in',
    reason: 'The session token for a page: answers a request with no session `signedOut` only.',
  },
  {
    path: '/api/auth/oidc/logout',
    verb: 'POST',
    admission: 'the-sign-in',
    reason: 'Signing out: clears the cookies and redirects, with or without a session.',
  },
  {
    path: '/api/auth/oidc/logout',
    verb: 'GET',
    admission: 'the-sign-in',
    reason: 'The signed-out page: words only.',
  },
];
