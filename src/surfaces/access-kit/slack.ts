import {
  EMPLOYEE_NAME_PLACEHOLDER,
  PUBLIC_URL_PLACEHOLDER,
  SLACK_APP_HOME,
  SLACK_REDIRECT_PATH,
  buildSlackManifest,
  type BuiltSlackManifest,
  type SlackManifest,
} from '../slack-manifest';
import type { AccessRecipe } from './types';

/*
 * Slack in the access kit (the access plan, sections 4.8 and 4.9; B9, S2 to S4): IT hands the
 * setup verb a configuration token and its refresh token, generated from a workspace service
 * account, and each employee's own Slack app is created from the manifest below. The manifest is
 * written once here, as a template with the two placeholders the documentation reader knows, and
 * built through the issuer's own builder (`buildSlackManifest`), so the app the kit prints, the
 * app the recipe page shows and the app the issuer sends are one app.
 */

/**
 * The bot scopes an employee's own app holds: exactly the methods Day0 calls in Slack, each
 * method's documented scope (read 1 October 2026): `chat.postMessage` and `chat.update`
 * (`chat:write`), `conversations.list` (`channels:read`, `im:read`), `conversations.history` and
 * `conversations.replies` (`channels:history`, `im:history`), `conversations.open` (`im:write`)
 * and `users.lookupByEmail` (`users:read.email`, which Slack grants only beside `users:read`),
 * and `conversations.join` (`channels:join`), with which a renewed employee re-joins the public
 * channels its approved intake scope names (RM4, ruled 2 October). `auth.test` needs none. Private
 * channels are added by hand by someone in them (RM4), so no `groups:` scope.
 */
export const SLACK_KIT_BOT_SCOPES: readonly string[] = [
  'chat:write',
  'channels:read',
  'channels:history',
  'channels:join',
  'im:read',
  'im:write',
  'im:history',
  'users:read',
  'users:read.email',
];

/** The app's description in Slack's directory: what the employee is, in Slack's 140 characters. */
const APP_DESCRIPTION =
  'A Day0 digital employee. It drafts first and holds what it posts until its manager approves.';

/** The manifest template, placeholders and all, as a policy page may carry it. */
const TEMPLATE: SlackManifest = {
  display_information: {
    name: `${EMPLOYEE_NAME_PLACEHOLDER} (Day0)`,
    description: APP_DESCRIPTION,
  },
  features: {
    bot_user: { display_name: `${EMPLOYEE_NAME_PLACEHOLDER} (Day0)`, always_online: false },
    app_home: { ...SLACK_APP_HOME },
  },
  oauth_config: {
    redirect_urls: [`${PUBLIC_URL_PLACEHOLDER}${SLACK_REDIRECT_PATH}`],
    scopes: { bot: [...SLACK_KIT_BOT_SCOPES] },
  },
  // Socket Mode and interactivity with no request URL (wave 12, 12-M; RM7): Approve and Reject
  // presses reach Day0 over the bridge's outbound socket once a person has generated the app's
  // app-level token, and nothing inbound is declared (Q13).
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
    interactivity: { is_enabled: true },
  },
};

/**
 * The kit's Slack manifest template: the JSON a policy page carries in a fenced block, with
 * `<employee name>` and `<Day0 public URL>` for the issuer to fill.
 */
export function slackKitManifestTemplate(): string {
  return JSON.stringify(TEMPLATE, null, 2);
}

/**
 * The manifest one employee's own Slack app is created from (11-AS's issuer sends this app).
 *
 * @param input.employeeName - The employee's name, which names the app and its bot user.
 * @param input.publicUrl - Day0's public https origin, which the redirect returns to.
 * @returns The manifest, the app's name, its redirect and its scopes, as the issuer builds them.
 * @throws ManifestTemplateError when the origin is not https or the name is empty, as the issuer refuses.
 */
export function slackKitManifest(input: {
  readonly employeeName: string;
  readonly publicUrl: string;
}): BuiltSlackManifest {
  return buildSlackManifest({
    agentName: input.employeeName,
    publicUrl: input.publicUrl,
    template: slackKitManifestTemplate(),
  });
}

/** Slack's recipe: per employee only (AI4), from a configuration token and its refresh token. */
export const SLACK_RECIPE: AccessRecipe = {
  system: 'slack',
  displayName: 'Slack',
  guide: 'docs/running/access-slack.md',
  redirectPath: SLACK_REDIRECT_PATH,
  vendorHosts: ['slack.com'],
  modes: [
    {
      mode: 'per-employee',
      kind: 'slack-configuration',
      scopes: SLACK_KIT_BOT_SCOPES,
      summary:
        'From a workspace service account (not a person), generate an app configuration token ' +
        'and keep its refresh token: Day0 creates each employee its own Slack app with it.',
      asks: [
        {
          field: 'secret',
          label: 'Slack app configuration token (hidden)',
          secret: true,
          stdinName: 'SLACK_CONFIGURATION_TOKEN',
          optional: false,
        },
        {
          field: 'refreshToken',
          label: 'Its refresh token (hidden)',
          secret: true,
          stdinName: 'SLACK_CONFIGURATION_REFRESH_TOKEN',
          optional: false,
        },
      ],
      secretLifetime: {
        words:
          'The configuration token expires 12 hours after it is generated. Day0 cannot tell how ' +
          'old a pair you hand it is, so it renews the pair with its refresh token at its first ' +
          'use or a quarter of an hour after it lands, whichever comes first (later while the ' +
          "deployment's scheduled jobs are paused); from then on it renews it before any use in " +
          'its last half hour and an hour before it lapses, and the refresh token also renews a ' +
          "token that has lapsed. Each renewal returns a new pair. A revoke, or the row's Delete on api.slack.com, ends " +
          'the access token only. Nothing ends a refresh token but its lapse, so keep the ' +
          "service account's sign-in closed: whoever copies a refresh token while its row is " +
          'listed can mint a token with it until then.',
      },
      landsAtInstall: true,
    },
  ],
};
