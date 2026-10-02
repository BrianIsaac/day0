import type { Attribution, CredentialKind } from './types';

/*
 * The access track's literals as the schema declares them (wave 11, 11-AK): whom a card acts as,
 * the organisation's connection it acts through, how Day0 obtained a credential and how that
 * credential's revocation at the vendor stands. One source, so the schema's validators, the
 * writers (11-AO to 11-AT) and the card's words (11-AC) name the same values, and an exhaustive
 * branch over any of them fails the typecheck when a value is added.
 */

/**
 * Whom an employee acts as in a system (the access plan, section 4.2; D2): its own app identity,
 * an app the organisation shares across its employees with Day0 recording which did what, a
 * person's delegated grant where the system has no app identity, a key someone pasted, or a
 * dedicated browser seat.
 */
export const ACTS_AS_KINDS = [
  'own-app',
  'shared-app',
  'delegated',
  'shared-key',
  'browser-seat',
] as const;

/** One of {@link ACTS_AS_KINDS}. */
export type ActsAsKind = (typeof ACTS_AS_KINDS)[number];

const ACTS_AS_LISTED: ReadonlySet<string> = new Set(ACTS_AS_KINDS);

/** Whether a value is one of {@link ACTS_AS_KINDS}. */
export function isActsAsKind(value: unknown): value is ActsAsKind {
  return typeof value === 'string' && ACTS_AS_LISTED.has(value);
}

/**
 * How writes through a card acting as this identity are attributed to the employee: a shared app,
 * a shared key and a person's delegated grant act as someone or something besides the employee,
 * so each write carries the employee's trailer; the employee's own app and its dedicated browser
 * seat are the employee at the vendor, which attributes the write itself.
 *
 * @param kind - Whom the card acts as.
 */
export function attributionOf(kind: ActsAsKind): Attribution {
  switch (kind) {
    case 'shared-app':
    case 'shared-key':
    case 'delegated':
      return 'trailer';
    case 'own-app':
    case 'browser-seat':
      return 'identity';
    default: {
      const unknown: never = kind;
      throw new Error(`unhandled identity kind ${String(unknown)}`);
    }
  }
}

/** The identity a card acts as, written by the connect paths and never by the model. */
export interface ActsAs {
  readonly kind: ActsAsKind;
  /** The identity's name as the system shows it: the app's name, or the key's label. */
  readonly label: string;
  /** The system's own id for the identity, where a probe read one (a Slack bot's user id). */
  readonly providerIdentityId?: string;
}

/**
 * What IT registered for a system at install (section 4.1): Slack's configuration token and its
 * refresh token, an OAuth app (Linear's, installed with `actor=app`), a service account, a
 * pre-registered MCP client, or a static key.
 */
export const ORGANISATION_CONNECTION_KINDS = [
  'slack-configuration',
  'oauth-app',
  'service-account',
  'mcp-client',
  'static-key',
] as const;

/** One of {@link ORGANISATION_CONNECTION_KINDS}. */
export type OrganisationConnectionKind = (typeof ORGANISATION_CONNECTION_KINDS)[number];

/**
 * Whether each employee gets its own identity in the system or all share the connection's (D3
 * with B11): chosen per system at install and recorded on the connection.
 */
export const ORGANISATION_CONNECTION_MODES = ['per-employee', 'shared'] as const;

/** One of {@link ORGANISATION_CONNECTION_MODES}. */
export type OrganisationConnectionMode = (typeof ORGANISATION_CONNECTION_MODES)[number];

/** Where an organisation connection stands: in use, needing IT, or revoked by an administrator. */
export const ORGANISATION_CONNECTION_STATUSES = ['active', 'needs-attention', 'revoked'] as const;

/** One of {@link ORGANISATION_CONNECTION_STATUSES}. */
export type OrganisationConnectionStatus = (typeof ORGANISATION_CONNECTION_STATUSES)[number];

/**
 * Where an organisation connection was registered from (B8): an administrator on the organisation
 * page, or the operator's setup verb run with the deployment's admin key.
 */
export const ORGANISATION_REGISTRARS = ['organisation-page', 'setup-cli'] as const;

/** One of {@link ORGANISATION_REGISTRARS}. */
export type OrganisationRegistrar = (typeof ORGANISATION_REGISTRARS)[number];

/**
 * How an MCP client connection's client id was obtained (AC7): registered with the server by IT
 * at install, or by dynamic registration where the server still offers it and the customer
 * allows it.
 */
export const MCP_CLIENT_REGISTRATIONS = ['pre-registered', 'dynamic'] as const;

/** One of {@link MCP_CLIENT_REGISTRATIONS}. */
export type McpClientRegistration = (typeof MCP_CLIENT_REGISTRATIONS)[number];

/**
 * How Day0 itself obtained a credential (`credentials.issuedBy`, section 4.4): an app install's
 * redirect, an authorisation-code exchange, a client-credentials grant, a token rotation, or an
 * app Day0 created (its client secret). Only such a credential is revoked at the vendor; a pasted
 * key never is (D5, AC4).
 */
export const CREDENTIAL_GRANTS = [
  'oauth-install',
  'authorisation-code',
  'client-credentials',
  'token-rotation',
  'app-created',
] as const;

/** One of {@link CREDENTIAL_GRANTS}. */
export type CredentialGrant = (typeof CREDENTIAL_GRANTS)[number];

/**
 * Where a credential's token lives (section 4.7, B15): in the `credentials` row itself, or in the
 * self-hosted Nango service, the row then holding the Nango connection's id.
 */
export const TOKEN_STORES = ['native', 'nango'] as const;

/** One of {@link TOKEN_STORES}. */
export type TokenStore = (typeof TOKEN_STORES)[number];

/**
 * How a credential's revocation at the vendor stands (section 4.4; F19): asked for and not yet
 * answered, done, impossible because the system has no revocation endpoint, or failed after the
 * last attempt.
 */
export const SOURCE_REVOCATION_STATES = ['pending', 'done', 'not-supported', 'failed'] as const;

/** One of {@link SOURCE_REVOCATION_STATES}. */
export type SourceRevocationState = (typeof SOURCE_REVOCATION_STATES)[number];

/**
 * Which end of access asked for a revocation at the vendor, so the revoker picks its call (S1, S4:
 * a disconnect or an expiry revokes the bot token and keeps the app; a retire deletes the app)
 * and a retry or the record reads it off the row.
 */
export const ACCESS_ENDS = [
  'disconnect',
  'expiry',
  'retire',
  'reject',
  'transfer',
  'organisation-revoked',
  'owner-deletion',
] as const;

/** One of {@link ACCESS_ENDS}. */
export type AccessEnd = (typeof ACCESS_ENDS)[number];

/**
 * Why a card drafted an access request instead of offering Connect (section 4.5; A24): its system
 * has no active organisation connection, its per-employee connection needs an administrator's
 * install, or the card needs a scope the registration does not hold.
 */
export const ACCESS_REQUEST_REASONS = [
  'no-connection',
  'install-needed',
  'scope-widening',
] as const;

/** One of {@link ACCESS_REQUEST_REASONS}. */
export type AccessRequestReason = (typeof ACCESS_REQUEST_REASONS)[number];

/** What the upgrade reads of a card to say whom it already acts as. */
export interface UpgradeCard {
  readonly displayName: string;
  readonly providerIdentityId?: string;
  readonly provisioning?: { readonly appName: string };
}

/** What the upgrade reads of the credential a card holds. */
export interface HeldCredential {
  readonly kind: CredentialKind;
  readonly label: string;
}

/**
 * Whom a card connected before the access track acts as, from the credential it holds (the
 * `surfaces-acts-as` migration; the access plan, section 4.2): an installed app's token is the
 * employee's own app, named as the app; a pasted value or location is a shared key, named as the
 * key. The bot's id a probe read stays with either.
 *
 * @param card - The card's name, its probed identity and its app registration.
 * @param credential - The live credential the card holds.
 */
export function actsAsAtUpgrade(card: UpgradeCard, credential: HeldCredential): ActsAs {
  const identity =
    card.providerIdentityId === undefined ? {} : { providerIdentityId: card.providerIdentityId };
  switch (credential.kind) {
    case 'oauth':
      return {
        kind: 'own-app',
        label: card.provisioning?.appName ?? card.displayName,
        ...identity,
      };
    case 'value':
    case 'location':
      return {
        kind: 'shared-key',
        label: credential.label.trim() || card.displayName,
        ...identity,
      };
    default: {
      const unknown: never = credential.kind;
      throw new Error(`unhandled credential kind ${String(unknown)}`);
    }
  }
}
