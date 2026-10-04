import type { WalkAnswer } from '../real-vendor-walk-2026-10-03';

/**
 * The answers real Linear (workspace `day00`) gave the two real-vendor walks of 3 October 2026
 * (round 0141: R-V on `v0.14.0` and the re-walk on `18b8261b`) that the walks' own fixtures beside
 * this file do not carry yet, word for word as the handovers log or quote them. Each entry names
 * its row. Where a handover quotes the words but elides the rest of the body, the entry carries only
 * what was quoted and says so. Token values the walks cut out are left out here too; ids are the
 * bed workspace's own (`tests/fixtures/README.md`).
 */

/** The shared app user the walks' client-credentials tokens acted as (R41V, V-A3; the re-walk, row 11). */
export const WALK_SHARED_APP_USER = {
  id: 'e4942e69-930f-429f-b284-5925cf794442',
  name: 'Day0',
} as const;

/**
 * GraphQL with a token Linear has revoked (the re-walk's log, row 4: `viewer` after a revoke of a
 * live client-credentials token): the whole body, under `HTTP 401`.
 */
export const GRAPHQL_NOT_AUTHENTICATED_401: WalkAnswer = {
  status: 401,
  body: {
    errors: [
      {
        message: 'Authentication required, not authenticated',
        extensions: {
          type: 'authentication error',
          code: 'AUTHENTICATION_ERROR',
          statusCode: 401,
          userError: true,
          userPresentableMessage: 'You need to authenticate to access this operation.',
          meta: {},
          http: { status: 401 },
        },
      },
    ],
  },
};

/** The content type every logged Linear OAuth and GraphQL answer carried (the re-walk's log). */
export const LINEAR_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * `viewer` with a live client-credentials token of the shared app (the re-walk's log, row 11):
 * `HTTP 200`, the app user and `app: true`.
 */
export const VIEWER_OF_SHARED_APP_200: WalkAnswer = {
  status: 200,
  body: { data: { viewer: { id: WALK_SHARED_APP_USER.id, name: 'Day0', app: true } } },
};

/**
 * How Linear printed the scope of a client-credentials token requested with
 * `read,write,app:assignable` (R41V decision 5, step 2; the re-walk's log, row 4): sorted and
 * space-separated, whatever order and separator the request used.
 */
export const ASSIGNABLE_SCOPE_AS_PRINTED = 'app:assignable read write';

/**
 * A manager's `issueUpdate` setting the delegate (or the assignee) to an app user that no live token
 * holding `app:assignable` covers (R41V decision 5, steps 1 and 2): the error's `message`, its
 * `code` and its `userPresentableMessage`, as quoted. The handover elides the rest of the body
 * ("...") and calls it "`INPUT_ERROR`, 400 in-band"; the HTTP status was not logged.
 */
export const APP_USER_LACKS_CAPABILITY = {
  message: 'App user not valid',
  code: 'INPUT_ERROR',
  userPresentableMessage: 'One or more app users lack the required capability.',
} as const;

/**
 * The bed key's user, the person who filed and delegated the walks' tickets (recorded 2 October as
 * `VIEWER_OF_API_KEY` in `linear-oauth-2026-10-02.ts`; the re-walk's log cuts it as `11ecf8f2-…`).
 */
export const WALK_KEY_PERSON_ID = '11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f';

/**
 * The same delegate with a token holding `app:assignable` live (the re-walk's log, row 1; R41V
 * decision 5, step 3): `HTTP 200`, the person still the assignee, the app user the delegate.
 */
export const DELEGATE_TO_SHARED_APP_200: WalkAnswer = {
  status: 200,
  body: {
    data: {
      issueUpdate: {
        success: true,
        issue: {
          identifier: 'REVOPS-37',
          assignee: { id: WALK_KEY_PERSON_ID },
          delegate: { id: WALK_SHARED_APP_USER.id, name: 'Day0' },
        },
      },
    },
  },
};

/**
 * The query whose answer {@link DELEGATE_TO_SHARED_APP_200} is: the fields the logged body names.
 */
export const DELEGATE_MUTATION =
  'mutation ($id: String!, $delegateId: String) { issueUpdate(id: $id, input: { delegateId: $delegateId }) ' +
  '{ success issue { identifier assignee { id } delegate { id name } } } }';

/**
 * Linear's authorise page for a link asking for `app:assignable` without `actor=app` (R41V, the
 * person's token, (a)): its words, as the walk read them on the page. Status and markup not logged.
 */
export const AUTHORISE_SCOPES_NOT_VALID_FOR_ACTOR =
  'The scopes requested are not valid for this actor mode.';

/**
 * Linear's consent for an employee's own app installed with `actor=app` and
 * `read,write,app:assignable` (R41V P4; the re-walk, row 2): the lines the walks quote, in order.
 */
export const CONSENT_LINES = [
  'is requesting access',
  'Read access',
  'Write access',
  'Assign issues and projects to the app in teams it can access',
  'Team access: All public teams',
] as const;

/**
 * Linear's confirmation behind an app's **Revoke access** in Settings, Applications (the re-walk,
 * row 3): it ends every token of the app, both grants.
 */
export const REVOKE_ACCESS_DIALOG = (appName: string): string =>
  `Revoke access for "${appName}"? This will revoke all existing tokens for "${appName}". ` +
  'You cannot undo this action.';

/**
 * A refresh replayed inside the 30-minute grace (R41V, L3, P7): the same new pair as the first
 * refresh returned, with `expires_in` the new access token's remaining life (86,397 a few seconds
 * after it was minted), and the scope printed sorted.
 */
export const REFRESH_REPLAY_EXPIRES_IN = 86_397;
