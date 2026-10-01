import { ConvexError } from 'convex/values';
import type { UserIdentity } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx, ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { EMPLOYEE_NOT_YOURS } from '../src/agent/employee-access';
import {
  CUSTOMER_OIDC_ISSUER_VAR,
  customerOidcAllowedDomains,
  customerOidcEmailTrusted,
  signInRefusal,
} from '../src/lib/customer-oidc';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SESSION_CLAIM } from '../src/lib/dev-auth-issuer';
import type { EnvReader } from '../src/lib/hosted-markers';
import { normaliseManagerAddress, sameManagerAddress } from '../src/agent/manager-address';
import {
  LOCAL_DEV_TRANSFER_REFUSAL,
  OWN_TRANSFER,
  TRANSFER_NOT_FOUND,
  UNVERIFIED_FOR_TRANSFER,
} from '../src/agent/manager-transfer';
import { resolveDeploymentProfile } from '../src/lib/surface-mode';
import { notAuthenticatedMessage } from './devAuth';

/**
 * Per-account ownership guards. Every public query/mutation/action that
 * touches a per-agent row calls one of these. Internal functions skip the
 * check - they're only callable from other Convex functions, which have
 * already verified the caller.
 *
 * `getCaller` is the single place a caller's identity enters the backend. Every
 * caller presents a verified token, from the local issuer, the customer's OIDC
 * issuer or Clerk (see `convex/auth.config.ts`); the owner key below is what
 * keeps two issuers from ever naming one owner.
 */

/** An issuer URL compared the way two spellings of one issuer should compare. */
function issuerKey(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/**
 * The key a caller's rows are stored under and checked against.
 *
 * A subject is unique only within its issuer, so a deployment that accepts two
 * issuers must not key rows on the subject alone: a customer token whose `sub`
 * is `dev-no-auth|local-boss` would otherwise own the local boss's rows. The
 * customer issuer's callers are keyed on `tokenIdentifier` (issuer and subject
 * together). The local issuer and Clerk keep the bare subject, since every row
 * from before a second issuer existed is keyed on it, and neither shares a
 * deployment with the other (Clerk is declared only when neither of the other
 * two is).
 *
 * @param identity - The verified token's identity.
 * @returns The owner key.
 */
export function ownerKeyOf(identity: UserIdentity): string {
  const customer = process.env[CUSTOMER_OIDC_ISSUER_VAR];
  if (customer && issuerKey(customer) === issuerKey(identity.issuer)) {
    return identity.tokenIdentifier;
  }
  return identity.subject;
}

/**
 * The browser session a caller's token was minted for, when its issuer names
 * one in `sid` (the local issuer, and OIDC issuers that follow the session
 * management claims), so a ledger can tell two browsers of one owner apart.
 *
 * @param identity - The caller's identity.
 * @returns The session id, or undefined when the token carries none.
 */
export function callerSessionId(identity: UserIdentity): string | undefined {
  const session = identity[DEV_NO_AUTH_SESSION_CLAIM];
  return typeof session === 'string' && session !== '' ? session : undefined;
}

/**
 * A verified caller: the token's own claims, `subject` included, plus the
 * owner key every guard compares and every row is keyed on ({@link ownerKeyOf}).
 */
export interface Caller extends UserIdentity {
  readonly ownerKey: string;
}

/**
 * The verified caller, or null for an anonymous one and for a customer-issuer
 * caller the domain rule refuses (decision S2): the second of the two places it
 * is checked, after the sign-in's callback, so a token forced past the callback
 * is refused here. The local issuer and Clerk keep their own rules.
 */
export async function getCaller(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  if (customerCallerRefused(identity, deploymentEnv)) return null;
  return { ...identity, ownerKey: ownerKeyOf(identity) };
}

/** The deployment's own env, as the auth config and the owner key read it. */
function deploymentEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Whether the domain rule refuses a caller: one the customer's issuer signed
 * whose `email` (and, for Google, `hd`) is outside `DAY0_OIDC_ALLOWED_DOMAINS`.
 * With no domain configured every such caller is refused, as the sign-in's
 * callback refuses them; an unreadable list refuses them too.
 */
function customerCallerRefused(identity: UserIdentity, read: EnvReader): boolean {
  if (callerIssuer(identity, read) !== 'customer') return false;
  let allowed: readonly string[];
  try {
    allowed = customerOidcAllowedDomains(read);
  } catch {
    // An entry that is not a domain: `check:setup` names it; meanwhile nobody is admitted by it.
    allowed = [];
  }
  return (
    signInRefusal({ email: identity.email, hd: identity.hd }, allowed, identity.issuer) !==
    undefined
  );
}

/** The three issuers a deployment accepts tokens from (`convex/auth.config.ts`). */
type CallerIssuer = 'local' | 'customer' | 'clerk';

/**
 * Which issuer signed a caller in. The auth config admits only these three,
 * and declares Clerk only when neither other one is configured, so a token
 * from neither the local issuer nor the customer's is Clerk's.
 */
function callerIssuer(identity: UserIdentity, read: EnvReader): CallerIssuer {
  const issuer = issuerKey(identity.issuer);
  if (issuer === issuerKey(DEV_NO_AUTH_ISSUER)) return 'local';
  const customer = read(CUSTOMER_OIDC_ISSUER_VAR);
  if (customer && issuer === issuerKey(customer)) return 'customer';
  return 'clerk';
}

/**
 * The token's own word on its address, as the deployment hands it over. An
 * OIDC provider's `email_verified` arrives mapped to `emailVerified`; a custom
 * JWT provider's (the local issuer's) arrives raw as `email_verified`, which a
 * self-hosted backend was seen to do on 1 October. Undefined when the token
 * says nothing; `true` only when every spelling present says `true`, so two
 * spellings that disagree verify nothing whichever comes first (the wave 9
 * review's U1-m1). Any value other than a boolean is not the claim and is
 * kept as said, so it never reads as absent.
 */
function emailVerifiedClaim(identity: UserIdentity): unknown {
  const said = [identity.emailVerified, identity.email_verified].filter(
    (claim: unknown) => claim !== undefined,
  );
  if (said.length === 0) return undefined;
  // Every spelling present must be `true`; anything else (a `false`, a string, a JSON null) is
  // returned as said, so it neither verifies nor reads as absent.
  return said.every((claim: unknown) => claim === true)
    ? true
    : said.find((claim: unknown) => claim !== true);
}

/**
 * The caller's verified address, trimmed and lower-cased: the address the
 * caller's own token proves, which is what makes a caller the manager of the
 * employees it owns and lets it answer a handover named to that address
 * (the transfer plan, section 3.2). Read per issuer:
 *
 * - Clerk: the `convex` template's `email`, when `email_verified` is true.
 * - The local issuer: the configured manager address the token route mints
 *   as `email`, with `email_verified` true, for whoever holds the signing key.
 * - The customer's issuer: `email` when `email_verified` is true; when the
 *   issuer sends no `email_verified`, when Entra's `xms_edov` is true (S4), and
 *   with neither claim only if the deployment declares its addresses trusted
 *   (`DAY0_OIDC_EMAIL_TRUSTED`, D3). An issuer that says `false` is taken at
 *   its word, flag or not, and an address at `day0.local` is never its.
 *
 * The claim is read in either spelling ({@link emailVerifiedClaim}), and only
 * a boolean `true` asserts it. Pure: it reads the token's claims and the
 * deployment env, nothing else.
 *
 * @param identity - The caller's verified token.
 * @param read - Reads one name of the deployment's env; its own by default.
 * @returns The address, or undefined when the token asserts none verified or it is not shaped like one.
 */
export function verifiedAddressOf(
  identity: UserIdentity,
  read: EnvReader = deploymentEnv,
): string | undefined {
  if (!addressVerified(identity, read)) return undefined;
  const address = normaliseManagerAddress(identity.email);
  if (address === undefined) return undefined;
  // The product's own domain has no mailbox, so no customer issuer can have verified one there;
  // only the local issuer, whose domain it is, vouches for it (the wave 9 review's U1-m4).
  if (address.endsWith(LOCAL_DOMAIN) && callerIssuer(identity, read) === 'customer') {
    return undefined;
  }
  return address;
}

/** The domain the local issuer's and the evaluation harness's addresses live at. */
const LOCAL_DOMAIN = '@day0.local';

/**
 * Whether the caller's token asserts its address verified, by its issuer's rule (D3). A
 * customer issuer that sends no `email_verified` may send Entra's `xms_edov` (S4): a boolean
 * `true` verifies the address, anything else is the issuer's word against it; only with neither
 * claim does the trust flag decide.
 */
function addressVerified(identity: UserIdentity, read: EnvReader): boolean {
  const claim = emailVerifiedClaim(identity);
  const issuer = callerIssuer(identity, read);
  switch (issuer) {
    case 'clerk':
    case 'local':
      return claim === true;
    case 'customer': {
      if (claim !== undefined) return claim === true;
      const domainOwnerVerified: unknown = identity.xms_edov;
      if (domainOwnerVerified !== undefined) return domainOwnerVerified === true;
      return customerOidcEmailTrusted(read);
    }
    default: {
      const unknown: never = issuer;
      throw new Error(`unhandled issuer ${String(unknown)}`);
    }
  }
}

/** The verified caller; throws the mode's not-authenticated message for an anonymous one. */
export async function getCallerOrThrow(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller> {
  const identity = await getCaller(ctx);
  if (!identity) throw new Error(notAuthenticatedMessage());
  return identity;
}

/** The employee, if the caller owns it; throws otherwise. The guard for a row keyed by agent id; the four below cover rows keyed otherwise. */
export async function assertOwnsAgent(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.ownerKey) throw new Error('forbidden');
  return agent;
}

/**
 * The employee, if the caller owns it, or null when no such row exists: the read for a page
 * that must answer a retired employee or a stale link rather than fail. Another owner's employee
 * is refused with {@link EMPLOYEE_NOT_YOURS} as a `ConvexError`, so the page can tell the refusal
 * from a crash after production strips every other error's text.
 */
export async function ownedAgentOrNull(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'> | null> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.db.get(agentId);
  if (agent === null) return null;
  if (!agent.userId || agent.userId !== identity.ownerKey) {
    throw new ConvexError(EMPLOYEE_NOT_YOURS);
  }
  return agent;
}

/** The employee, if the caller owns it, for an action that has no database handle. */
export async function assertOwnsAgentAction(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.runQuery(internal.agents.getInternal, { agentId });
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.ownerKey) throw new Error('forbidden');
  return agent;
}

/**
 * Whether no second account can exist on this deployment for this caller: it
 * signed in through the local issuer, which signs every browser in as one
 * subject, and the profile is `local-dev`. Under `customer-local` the local
 * account is one more manager beside the customer's issuer (the transfer plan,
 * section 8). The ask in `convex/managerTransfers.ts` reads the same rule.
 *
 * @param identity - The caller's verified token.
 */
export function signedInAsTheOneLocalManager(identity: UserIdentity): boolean {
  return (
    issuerKey(identity.issuer) === issuerKey(DEV_NO_AUTH_ISSUER) &&
    resolveDeploymentProfile() === 'local-dev'
  );
}

/** A handover request and the account it names, as {@link assertNamedInTransfer} answers them. */
export interface NamedInTransfer {
  readonly transfer: Doc<'managerTransfers'>;
  readonly caller: Caller;
}

/**
 * The handover request and its caller, if the caller is the account it names:
 * signed in with a verified address equal to the request's `toAddress`, and
 * not the account that asked, whatever its addresses (the transfer plan,
 * section 5.1). The guard for the named manager's reads and answers, the
 * counterpart of {@link assertOwnsAgent} for the employee's owner; it says
 * nothing about the request's state, which each caller checks for its own move.
 *
 * The one local manager of a `local-dev` deployment (every browser on the local
 * key is one subject) is refused as it is at the ask, since it cannot be told
 * apart from whoever else holds the key (the wave 9 review's U1-m3). An
 * unverified caller is refused before anything is read, and every caller the
 * request does not name reads it as one that does not exist, as does a string
 * that is not a request's id (a link pasted wrong, another table's row): an id
 * is confirmed to nobody it does not name (the wave 9 review's U1-m2, U4-m1).
 *
 * @param transferId - The request's id as the caller gave it, checked here.
 * @throws ConvexError with {@link LOCAL_DEV_TRANSFER_REFUSAL}, {@link UNVERIFIED_FOR_TRANSFER},
 *   {@link TRANSFER_NOT_FOUND} or {@link OWN_TRANSFER}, words the dialog shows; the
 *   not-authenticated error for an anonymous caller.
 */
export async function assertNamedInTransfer(
  ctx: QueryCtx | MutationCtx,
  transferId: string,
): Promise<NamedInTransfer> {
  const caller = await getCallerOrThrow(ctx);
  if (signedInAsTheOneLocalManager(caller)) throw new ConvexError(LOCAL_DEV_TRANSFER_REFUSAL);
  const address = verifiedAddressOf(caller);
  if (address === undefined) throw new ConvexError(UNVERIFIED_FOR_TRANSFER);
  const id = ctx.db.normalizeId('managerTransfers', transferId);
  const transfer = id === null ? null : await ctx.db.get(id);
  if (!transfer || !sameManagerAddress(address, transfer.toAddress)) {
    throw new ConvexError(TRANSFER_NOT_FOUND);
  }
  if (caller.ownerKey === transfer.fromOwnerKey) throw new ConvexError(OWN_TRANSFER);
  return { transfer, caller };
}

/** The charter, if the caller owns its employee; throws otherwise. */
export async function assertOwnsCharter(
  ctx: QueryCtx | MutationCtx,
  charterId: Id<'charters'>,
): Promise<Doc<'charters'>> {
  const charter = await ctx.db.get(charterId);
  if (!charter) throw new Error('charter not found');
  await assertOwnsAgent(ctx, charter.agentId);
  return charter;
}

/** The work item, if the caller owns its employee; throws otherwise. */
export async function assertOwnsWorkItem(
  ctx: QueryCtx | MutationCtx,
  workItemId: Id<'workItems'>,
): Promise<Doc<'workItems'>> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item not found');
  await assertOwnsAgent(ctx, item.agentId);
  return item;
}

/** The skill, if the caller owns its employee; throws otherwise. */
export async function assertOwnsSkill(
  ctx: QueryCtx | MutationCtx,
  skillId: Id<'skills'>,
): Promise<Doc<'skills'>> {
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error('skill not found');
  await assertOwnsAgent(ctx, skill.agentId);
  return skill;
}

/** The voice session, if the caller owns its employee; throws otherwise. */
export async function assertOwnsVoiceSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<'voiceSessions'>,
): Promise<Doc<'voiceSessions'>> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error('voice session not found');
  await assertOwnsAgent(ctx, session.agentId);
  return session;
}
