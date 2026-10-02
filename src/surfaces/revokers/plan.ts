import type { AccessEnd, CredentialGrant } from '../access-identity';
import { systemDisplayName } from './outcome';
import type { TokenTypeHint } from './types';

/*
 * Which call ends a credential at its vendor, for which end of access (the access plan, section
 * 4.4; the wave 11 file's 11-AR with the 1 October correction). Only a credential Day0 itself
 * obtained (it carries `issuedBy`) is ever planned here; a pasted key never reaches this module
 * (D5, AC4), and the callers refuse one before they ask.
 */

/** How Day0 obtained the credential, as far as choosing its revocation reads it. */
export interface RevocationIssuer {
  readonly system: string;
  readonly grant: CredentialGrant;
  readonly appId?: string;
  readonly clientId?: string;
}

/** The credential a plan is for: how Day0 obtained it and which token it is. */
export interface RevocationSubject {
  readonly issuedBy: RevocationIssuer;
  /** An access token (or a bot token, or an app's secret), or the refresh token paired with one. */
  readonly role: 'access' | 'refresh';
}

/** What {@link sharedByOrganisation} reads of a credential row. */
export interface CredentialHolding {
  readonly holder?: 'organisation';
  readonly issuedBy?: { readonly grant: CredentialGrant };
}

/**
 * Whether a credential row is the organisation's own, which every employee shares and no one
 * employee's end of access touches: a row the organisation holds that Day0 did not obtain for one
 * employee (an organisation connection's secret, which carries no `issuedBy`) or that is a
 * client-credentials app-actor token (L2). A per-employee identity's tokens are held by the
 * organisation too (the wave 11 common rules) and are not shared: how Day0 obtained a row decides
 * whether it is revoked, not who holds it.
 *
 * @param row - The credential row.
 */
export function sharedByOrganisation(row: CredentialHolding): boolean {
  return (
    row.holder !== undefined &&
    (row.issuedBy === undefined || row.issuedBy.grant === 'client-credentials')
  );
}

/** What Day0 holds that a revocation may need beside the credential itself. */
export interface RevocationMeans {
  /** A configuration token of the Slack connection the app was created through. */
  readonly configurationToken: boolean;
  /** The app's client secret, kept with the credential until its revocation is final (F19). */
  readonly clientSecret: boolean;
  /** The revocation endpoint the authorisation server advertises (RFC 8414), when it does. */
  readonly revocationEndpoint?: string;
}

/** One call to a vendor. */
export type RevocationCall =
  | { readonly kind: 'slack-revoke-token' }
  | { readonly kind: 'slack-delete-app'; readonly appId: string }
  | { readonly kind: 'slack-uninstall-app'; readonly clientId: string }
  | { readonly kind: 'linear-revoke'; readonly hint: TokenTypeHint }
  | {
      readonly kind: 'oauth-revoke';
      readonly endpoint: string;
      readonly hint: TokenTypeHint;
      readonly clientId?: string;
    };

/** Why no vendor is called: no endpoint, a token the organisation shares, or an end that keeps it. */
export type NoRevocationOutcome = 'not-supported' | 'shared' | 'not-at-vendor';

/**
 * A credential's revocation: calls in order of preference, the first that is done ending it, or
 * no call, with the words the record keeps.
 */
export type RevocationPlan =
  | { readonly kind: 'call'; readonly calls: readonly RevocationCall[] }
  | { readonly kind: 'none'; readonly outcome: NoRevocationOutcome; readonly words: string };

/**
 * Whether an end of access leaves nothing of the employee at the vendor (S4: its Slack app is
 * deleted) or keeps its identity for a renewal (S1: the bot token is revoked, the app stays).
 * Exhaustive by its declared return, so a new end must be placed.
 *
 * @param end - The end of access.
 */
export function endRemovesApp(end: AccessEnd): boolean {
  switch (end) {
    case 'retire':
    case 'reject':
    case 'owner-deletion':
      return true;
    case 'disconnect':
    case 'expiry':
    case 'organisation-revoked':
    case 'transfer':
      return false;
  }
}

/** The words for a handover, which calls no vendor (A25). */
export const HANDOVER_WORDS =
  'A handover changes nothing at the vendor; the new manager re-approves the system.';

/** The words for a token every employee shares (L2). */
const SHARED_WORDS = "Shared app token: not revoked (the app's other employees use it).";

/** Slack's plan: the token-keeping ends revoke the bot token; the others delete the app. */
function slackPlan(
  subject: RevocationSubject,
  end: AccessEnd,
  means: RevocationMeans,
): RevocationPlan {
  const { appId, clientId, grant } = subject.issuedBy;
  const deletion: RevocationCall[] =
    means.configurationToken && appId !== undefined ? [{ kind: 'slack-delete-app', appId }] : [];
  if (grant === 'app-created') {
    if (!endRemovesApp(end)) {
      return { kind: 'none', outcome: 'not-at-vendor', words: 'The app stays for the renewal.' };
    }
    return deletion.length > 0
      ? { kind: 'call', calls: deletion }
      : {
          kind: 'none',
          outcome: 'not-supported',
          words:
            "Day0 holds no configuration token to delete the app; delete it in Slack's app settings.",
        };
  }
  if (!endRemovesApp(end)) return { kind: 'call', calls: [{ kind: 'slack-revoke-token' }] };
  const uninstall: RevocationCall[] =
    means.clientSecret && clientId !== undefined ? [{ kind: 'slack-uninstall-app', clientId }] : [];
  return { kind: 'call', calls: [...deletion, ...uninstall, { kind: 'slack-revoke-token' }] };
}

/**
 * Choose how to end one credential Day0 obtained at its vendor, for one end of access.
 *
 * A handover calls nothing (A25). A client-credentials app-actor token is shared by other
 * employees and never revoked (L2); a per-employee token is revoked whoever holds its row
 * ({@link sharedByOrganisation}). Slack's two calls follow
 * {@link endRemovesApp}; Linear revokes each token of the pair by its hint (L3); an MCP server is
 * revoked at the endpoint it advertises (RFC 7009); a system with no revoker, or an app Linear
 * cannot delete by API (L1), is named as such.
 *
 * @param subject - The credential.
 * @param end - The end of access asking for it.
 * @param means - What else Day0 holds for the call.
 */
export function revocationPlanFor(
  subject: RevocationSubject,
  end: AccessEnd,
  means: RevocationMeans,
): RevocationPlan {
  if (end === 'transfer') return { kind: 'none', outcome: 'not-at-vendor', words: HANDOVER_WORDS };
  const { system, grant, clientId } = subject.issuedBy;
  if (grant === 'client-credentials') {
    return { kind: 'none', outcome: 'shared', words: SHARED_WORDS };
  }
  const hint: TokenTypeHint = subject.role === 'refresh' ? 'refresh_token' : 'access_token';
  if (system === 'slack') return slackPlan(subject, end, means);
  if (system === 'linear') {
    if (grant === 'app-created') {
      return {
        kind: 'none',
        outcome: 'not-supported',
        words: "Linear has no call to delete an app; delete it in Linear's settings.",
      };
    }
    return { kind: 'call', calls: [{ kind: 'linear-revoke', hint }] };
  }
  if (system.startsWith('mcp:')) {
    if (means.revocationEndpoint === undefined) {
      return {
        kind: 'none',
        outcome: 'not-supported',
        words: `${systemDisplayName(system)} advertises no revocation endpoint; Day0's copy is deleted.`,
      };
    }
    return {
      kind: 'call',
      calls: [
        {
          kind: 'oauth-revoke',
          endpoint: means.revocationEndpoint,
          hint,
          ...(clientId !== undefined ? { clientId } : {}),
        },
      ],
    };
  }
  return {
    kind: 'none',
    outcome: 'not-supported',
    words: `${system}: no revocation endpoint; Day0's copy is deleted.`,
  };
}

/**
 * What a call means once the vendor did it: a token revoked, or the app deleted or uninstalled.
 * Exhaustive by its declared return.
 *
 * @param call - One call of a plan.
 */
export function callOutcome(
  call: RevocationCall,
): 'token-revoked' | 'app-deleted' | 'app-uninstalled' {
  switch (call.kind) {
    case 'slack-delete-app':
      return 'app-deleted';
    case 'slack-uninstall-app':
      return 'app-uninstalled';
    case 'slack-revoke-token':
    case 'linear-revoke':
    case 'oauth-revoke':
      return 'token-revoked';
  }
}
