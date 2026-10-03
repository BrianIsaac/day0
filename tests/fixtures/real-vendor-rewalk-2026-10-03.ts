import type { WalkAnswer } from './real-vendor-walk-2026-10-03';

/**
 * What real Linear (workspace `day00`) and real Slack (workspace `day0`) showed and answered the
 * re-walk on the release candidate `18b8261b`, 3 October 2026 (round 0141, the re-walk), word for
 * word as its handover quotes them. Token values the walk cut out are left out here too.
 */

/**
 * Slack's dialog behind a configuration token row's **Delete token** on api.slack.com (R41X-8,
 * row 5): it ends that access token, and nothing else.
 */
export const SLACK_ROW_DELETE_DIALOG =
  'Revoke this token? This will invalidate this token, which means any requests using this token ' +
  'will no longer work. This cannot be undone.';

/**
 * Slack `tooling.tokens.rotate` with the configuration refresh token Day0 held, after Day0's
 * `auth.revoke` of its access token (R41X-8, row 5, 16:15:28Z), and again after the row's Delete
 * (16:17:39Z): Slack still minted a new pair, so neither end ends the refresh token. The minted
 * values are cut out.
 */
export const SLACK_ROTATE_AFTER_EVERY_END: WalkAnswer = { status: 200, body: { ok: true } };

/** Linear `POST /oauth/revoke` of a token Linear never issued (R41X-1, row 10, 15:23:05Z). */
export const LINEAR_REVOKE_TOKEN_NOT_FOUND: WalkAnswer = {
  status: 401,
  body: { error: 'Token not found' },
};

/**
 * Linear `POST /oauth/revoke` of a token whose grant had already ended (the re-walk's log, rows 2
 * and 4): the status is 401, where the first walk's fixture inferred 400.
 */
export const LINEAR_REVOKE_ALREADY_REVOKED_401: WalkAnswer = {
  status: 401,
  body: { error: 'Token has already been revoked.' },
};

/**
 * Linear's refresh of a grant revoked in Linear's settings (R41X-4, row 3, 15:44:22Z): the card
 * is refused and the dead pair stays on it.
 */
export const LINEAR_REFRESH_TOKEN_REVOKED_400: WalkAnswer = {
  status: 400,
  body: { error: 'invalid_request', error_description: 'Refresh token revoked' },
};

/** Linear's create form opened from any `?manifest=` link (R41X-2, row 7): nothing pre-filled. */
export const LINEAR_MANIFEST_LINK_REFUSED = 'The app manifest provided in the URL is not valid';

/**
 * The bed's public origin the re-walk's Linear apps were created against (row 7, W-L4).
 */
export const REWALK_PUBLIC_URL = 'https://127.0.0.1:3580';

/**
 * The link that pre-filled Linear's create form for Leo's own app (R41X-2, row 7, W-L4): name
 * "Leo (Day0)", developer Day0, the developer URL and the redirect the bed's, client credentials
 * off. The walk quotes the origin as `<origin>`; it is filled in here with the bed's.
 */
export const LINEAR_PREFILLED_FORM_LINK =
  'https://linear.app/settings/api/applications/new?distribution=private&developer.name=Day0' +
  `&oauth.client_name=Leo%20(Day0)&oauth.client_uri=${REWALK_PUBLIC_URL}` +
  `&oauth.redirect_uris=${REWALK_PUBLIC_URL}%2Fapi%2Foauth%2Flinear` +
  '&oauth.grant_types=authorization_code';

/**
 * How Linear names an employee's own app Day0 created the form for (R41X-3, row 2): its consent
 * "Leo (Day0) is requesting access ...", and `viewer` as "Leo (Day0)".
 */
export const LINEAR_OWN_APP_NAME = 'Leo (Day0)';

/**
 * Day0's own answer when Juno's retire ran with IT's new Slack connection live (R41X-9, row 8):
 * the retire cannot delete an app whose creating connection was revoked.
 */
export const SLACK_RETIRE_ORPHANED_APP =
  "Day0 holds no configuration token to delete the app; delete it in Slack's app settings.";
