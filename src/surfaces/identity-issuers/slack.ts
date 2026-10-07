import type { Id } from '../../../convex/_generated/dataModel';
import type { ActsAs, CredentialGrant } from '../access-identity';
import { slackKitManifestTemplate } from '../access-kit/slack';
import {
  buildSlackManifest,
  extractManifestTemplate,
  type BuiltSlackManifest,
} from '../slack-manifest';

/*
 * Slack's identity issuer (wave 11, 11-AS; the access plan, sections 4.2 and 4.9): each employee
 * acts as its own Slack app (D2), created with the organisation's configuration token, which Day0
 * keeps current with its refresh token (B9). This module is the pure half: which manifest the app
 * is created from, when the configuration token is renewed, how Slack's rotation is read, what
 * each row Day0 stores says about how it was obtained (11-AR reads `issuedBy`), whom the card acts
 * as, and which channels a renewed bot re-joins itself (RM4). The calls are made by
 * `convex/slackProvisionActions.ts`.
 */

/** The system key of Slack's organisation connection and of every row its issuer stores. */
export const SLACK_SYSTEM = 'slack';

/** How long a configuration token lives after Slack issues it (S2: "expire 12 hours after"). */
export const CONFIGURATION_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * How much life a configuration token must have left to be used as it is: a use rotates first
 * when less remains, so the one call it makes never meets a token that lapses under it.
 */
export const CONFIGURATION_RENEW_BEFORE_MS = 30 * 60 * 1000;

/**
 * How long before its expiry the kept token is renewed even when nothing uses it, so a retire's
 * `apps.manifest.delete` (11-AR, which reads the stored token as it stands) finds it current.
 */
export const CONFIGURATION_KEEP_CURRENT_BEFORE_MS = 60 * 60 * 1000;

/**
 * The soonest the next renewal runs after one is queued, so a token Slack says lapses within the
 * hour (or one whose expiry is already past) is renewed every quarter-hour at most, never in a loop.
 */
export const KEEP_CURRENT_MIN_DELAY_MS = 15 * 60 * 1000;

/** Why an app cannot be created: the organisation has no Slack connection, and nothing was pasted. */
export const NO_CONFIGURATION_TOKEN =
  "Paste an app configuration token: the organisation has no active Slack connection to create this employee's app with.";

/**
 * Why a kept app is not installed again: IT revoked the connection that created it. Nor can Day0
 * delete it afterwards, even through a connection IT lands again: only the creating connection's
 * configuration token could, and its retire says so (the re-walk, R41X-9). The manager forgets it
 * on the card for a new one to be created (13-FS's design 2 (b)).
 */
export const KEPT_APP_CONNECTION_REVOKED =
  "IT revoked the organisation's Slack connection this employee's app was created with, so the " +
  'app is not installed again, and Day0 cannot delete it, even once IT connects Slack again: ' +
  "IT deletes it in Slack's app settings. To get a new app, forget this one on the card.";

/** The manifest an employee's app is created from, and which template it was built from. */
export interface SlackAppManifest extends BuiltSlackManifest {
  /** The documentation's own template, or the access kit's where the pages carry none. */
  readonly template: 'documentation' | 'kit';
}

/**
 * Build the manifest of one employee's own app: from the template the documentation carries, as
 * Day0 has always done, else from the access kit's (`slackKitManifestTemplate`), which is the app
 * IT was shown at install. Both go through `buildSlackManifest`, so the settings allowlist and the
 * redirect check hold either way.
 *
 * @param input.documentation - The joined markdown of the pages the employee reads.
 * @param input.employeeName - The employee's name, which names the app and its bot user.
 * @param input.publicUrl - Day0's public https origin, which the install redirects back to.
 * @throws ManifestTemplateError when the template or the resulting manifest is unusable.
 */
export function slackAppManifest(input: {
  readonly documentation: string;
  readonly employeeName: string;
  readonly publicUrl: string;
}): SlackAppManifest {
  const documented = extractManifestTemplate(input.documentation);
  const built = buildSlackManifest({
    agentName: input.employeeName,
    publicUrl: input.publicUrl,
    template: documented ?? slackKitManifestTemplate(),
  });
  return { ...built, template: documented === undefined ? 'kit' : 'documentation' };
}

/** What a use reads of the kept configuration token: its expiry, and whether it can be renewed. */
export interface HeldConfiguration {
  /** When the token lapses, once a rotation has said; absent for a token of unknown age. */
  readonly expiresAt?: number;
  /** Whether a live refresh token is paired with it. */
  readonly refreshable: boolean;
}

/**
 * Whether a use of the configuration token rotates it first: when it has less than
 * {@link CONFIGURATION_RENEW_BEFORE_MS} left, has lapsed, or is of unknown age (the token IT
 * landed, until its first rotation says when it lapses). A token with no refresh token beside it
 * is used as it is: there is nothing to rotate with, and Slack's answer says whether it still works.
 *
 * @param held - The kept token's expiry and whether it is refreshable.
 * @param now - The instant of the use.
 */
export function configurationRenewal(held: HeldConfiguration, now: number): 'use' | 'rotate' {
  if (!held.refreshable) return 'use';
  if (held.expiresAt === undefined) return 'rotate';
  return held.expiresAt - now > CONFIGURATION_RENEW_BEFORE_MS ? 'use' : 'rotate';
}

/**
 * When the kept token is next renewed though nothing uses it: {@link
 * CONFIGURATION_KEEP_CURRENT_BEFORE_MS} before it lapses, and never sooner than {@link
 * KEEP_CURRENT_MIN_DELAY_MS} from now.
 *
 * @param expiresAt - When the token lapses.
 * @param now - The instant the renewal is scheduled at.
 */
export function keepCurrentAt(expiresAt: number, now: number): number {
  return Math.max(
    now + KEEP_CURRENT_MIN_DELAY_MS,
    expiresAt - CONFIGURATION_KEEP_CURRENT_BEFORE_MS,
  );
}

/** A rotated configuration pair, as `tooling.tokens.rotate` returned it. */
export interface RotatedConfiguration {
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

/**
 * Read `tooling.tokens.rotate`'s answer: the new configuration token, the new refresh token, and
 * the expiry Slack states (`exp`, in seconds) held between now and the documented twelve hours,
 * else the twelve hours.
 *
 * @param payload - Slack's successful answer.
 * @param now - The instant of the rotation.
 * @throws Error when either half of the pair is missing, since the pair is only kept whole.
 */
export function parseTokenRotation(
  payload: Readonly<Record<string, unknown>>,
  now: number,
): RotatedConfiguration {
  const { token, refresh_token: refreshToken, exp } = payload;
  if (typeof token !== 'string' || token === '') {
    throw new Error('Slack tooling.tokens.rotate returned no new configuration token.');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error('Slack tooling.tokens.rotate returned no new refresh token.');
  }
  const longest = now + CONFIGURATION_TOKEN_LIFETIME_MS;
  // Slack's stated expiry is held to the documented twelve hours, and one already past to now
  // (renewed at its next use), so a bad clock on either side never keeps a token past its life.
  const expiresAt =
    typeof exp === 'number' && Number.isFinite(exp) && exp > 0
      ? Math.min(Math.max(exp * 1000, now), longest)
      : longest;
  return { token, refreshToken, expiresAt };
}

/**
 * The errors that say the refresh token can no longer be exchanged, so only IT's new pair revives
 * the connection. Any other failure (a limit, Slack's own error, no answer) may pass.
 */
const SPENT_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_refresh_token',
  'token_revoked',
  'token_expired',
  'invalid_auth',
  'not_authed',
  'account_inactive',
]);

/** The errors that say Slack no longer accepts a configuration token Day0 holds as current. */
const REFUSED_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
]);

/**
 * Whether Slack refused the configuration token itself, so a use rotates it and tries once more.
 *
 * @param error - Slack's error word, when it gave one.
 */
export function configurationTokenRefused(error: string | undefined): boolean {
  return error !== undefined && REFUSED_TOKEN_ERRORS.has(error);
}

/**
 * What a refused rotation means: the refresh token is spent (IT generates a new pair), or the
 * refusal may pass on a later attempt.
 *
 * @param error - Slack's error word, when it gave one.
 */
export function rotationRefusal(error: string | undefined): 'spent' | 'transient' {
  return error !== undefined && SPENT_REFRESH_ERRORS.has(error) ? 'spent' : 'transient';
}

/** What a Slack row's `issuedBy` says (the `credentialIssuerValidator` shape). */
export interface SlackIssuedBy {
  readonly system: typeof SLACK_SYSTEM;
  readonly grant: Extract<CredentialGrant, 'app-created' | 'oauth-install'>;
  readonly appId: string;
  readonly clientId: string;
  readonly organisationConnectionId?: Id<'organisationConnections'>;
  readonly clientSecretCredentialId?: Id<'credentials'>;
}

/** The app an issued row belongs to. */
export interface IssuedSlackApp {
  readonly appId: string;
  readonly clientId: string;
  /** The configuration connection that created the app; absent for a token pasted on the card. */
  readonly organisationConnectionId?: Id<'organisationConnections'>;
}

/**
 * `issuedBy` of an app's client secret: Day0 obtained it by creating the app. 11-AR keeps it with
 * the bot token for `apps.uninstall` and never revokes it on its own.
 *
 * @param app - The app and the connection that created it.
 */
export function slackClientSecretIssuer(app: IssuedSlackApp): SlackIssuedBy {
  return {
    system: SLACK_SYSTEM,
    grant: 'app-created',
    appId: app.appId,
    clientId: app.clientId,
    ...(app.organisationConnectionId === undefined
      ? {}
      : { organisationConnectionId: app.organisationConnectionId }),
  };
}

/**
 * `issuedBy` of a bot token: Day0 obtained it by the app's install, so an end of access revokes it
 * (`auth.revoke`) or ends the app (`apps.manifest.delete` with the connection, else
 * `apps.uninstall` with the client secret named here).
 *
 * @param app - The app, the connection that created it and its client secret's row.
 */
export function slackBotTokenIssuer(
  app: IssuedSlackApp & { readonly clientSecretCredentialId: Id<'credentials'> },
): SlackIssuedBy {
  return {
    ...slackClientSecretIssuer(app),
    grant: 'oauth-install',
    clientSecretCredentialId: app.clientSecretCredentialId,
  };
}

/**
 * `issuedBy` of the bot token a card's own app's install gives, read off the card's
 * `provisioning`: the app, the connection that created it when one did, and its client secret.
 *
 * @param provisioning - The card's app, as `provisioning` records it.
 */
export function installedBotIssuer(provisioning: {
  readonly appId: string;
  readonly clientId: string;
  readonly organisationConnectionId?: Id<'organisationConnections'>;
  readonly clientSecretCredentialId: Id<'credentials'>;
}): SlackIssuedBy {
  return slackBotTokenIssuer({
    appId: provisioning.appId,
    clientId: provisioning.clientId,
    ...(provisioning.organisationConnectionId === undefined
      ? {}
      : { organisationConnectionId: provisioning.organisationConnectionId }),
    clientSecretCredentialId: provisioning.clientSecretCredentialId,
  });
}

/** A stored row's `issuedBy` (the `credentialIssuerValidator` shape), as the check reads it. */
export interface HeldIssuer {
  readonly system: string;
  readonly grant: string;
  readonly appId?: string;
  readonly clientId?: string;
  readonly organisationConnectionId?: string;
  readonly clientSecretCredentialId?: string;
}

/**
 * Whether a stored row's `issuedBy` is exactly the one the issuer gives it: the row the action
 * just stored for this app, with this grant (the pre-tag's item 10, `credentials.store` writing it
 * with the value).
 *
 * @param held - The row's `issuedBy`, as stored.
 * @param expected - What the issuer gives the row (`slackClientSecretIssuer`, `installedBotIssuer`).
 */
export function isIssuedAs(held: HeldIssuer | undefined, expected: SlackIssuedBy): boolean {
  return (
    held !== undefined &&
    held.system === expected.system &&
    held.grant === expected.grant &&
    held.appId === expected.appId &&
    held.clientId === expected.clientId &&
    held.organisationConnectionId === expected.organisationConnectionId &&
    held.clientSecretCredentialId === expected.clientSecretCredentialId
  );
}

/**
 * Whom a card with an installed own app acts as (D2): the app, by its name, and its bot user.
 *
 * @param app.appName - The app's name, as the manifest built it.
 * @param app.botUserId - The bot user the install returned, when it did.
 */
export function slackActsAs(app: {
  readonly appName: string;
  readonly botUserId?: string;
}): ActsAs {
  return {
    kind: 'own-app',
    label: app.appName,
    ...(app.botUserId === undefined ? {} : { providerIdentityId: app.botUserId }),
  };
}

/** A public channel as `conversations.list` shows it to the bot. */
export interface VisibleChannel {
  readonly id: string;
  readonly name: string;
  readonly isMember: boolean;
}

/** What a renewed bot does about each channel its approved intake scope names. */
export interface RejoinPlan {
  /** The public channels it joins itself (`conversations.join`). */
  readonly join: readonly { readonly id: string; readonly name: string }[];
  /** The public channels it is already in, each as `#name`. */
  readonly alreadyIn: readonly string[];
  /**
   * The channels it cannot join itself, each as `#name`: a private channel (never listed to a
   * bot outside it) or one the workspace does not have. A person in it adds the employee (RM4).
   */
  readonly needsPerson: readonly string[];
}

/** A channel name as Slack lists it: no leading `#`, lower case. */
function channelName(value: string): string {
  return value.trim().replace(/^#+/, '').trim().toLowerCase();
}

/**
 * Plan the re-join after a renewal (RM4, ruled): every approved channel that is public is joined
 * by the bot itself; every other is named as needing a person. Each name once, in the scope's order.
 *
 * @param approved - The channel names the card's approved intake scope names.
 * @param visible - The public channels the bot can see, with its membership of each.
 */
export function rejoinPlan(
  approved: readonly string[],
  visible: readonly VisibleChannel[],
): RejoinPlan {
  const byName = new Map(visible.map((channel) => [channelName(channel.name), channel]));
  const names = [...new Set(approved.map(channelName))].filter((name) => name !== '');
  const join: { id: string; name: string }[] = [];
  const alreadyIn: string[] = [];
  const needsPerson: string[] = [];
  for (const name of names) {
    const channel = byName.get(name);
    if (channel === undefined) needsPerson.push(`#${name}`);
    else if (channel.isMember) alreadyIn.push(`#${name}`);
    else join.push({ id: channel.id, name });
  }
  return { join, alreadyIn, needsPerson };
}
